/**
 * Payment-intent execution path — the idempotent, double-charge-safe core of
 * the recovery collection flow.
 *
 * This supersedes the legacy `executeProposal` for *customer-initiated
 * collections* because it introduces the missing concept the old path lacked:
 * a stable PAYMENT INTENT keyed by the client-supplied idempotency key. A retry
 * (including the dangerous "provider charged but the response was lost" case)
 * resolves to the SAME charge and NEVER a second one.
 *
 * Lifecycle:
 *   1. Look up intent by clientIdemKey.
 *      - terminal (SUCCEEDED/FAILED/CANCELLED) → return it, do NOT re-execute.
 *      - PROCESSING/UNKNOWN              → already submitted, do NOT start a new charge.
 *   2. Otherwise create intent (PROCESSING); the UNIQUE(client_idem_key) index
 *      makes a concurrent duplicate insert fail → that caller also sees "already
 *      submitted". This is the single-flight guard.
 *   3. Call the (mock) provider.
 *   4. Resolve:
 *      - succeeded / lost_response → DEBIT ledger once, intent SUCCEEDED,
 *        proposal EXECUTED. lost_response ⇒ clientVisible = UNKNOWN
 *        (charge applied, but the response never reached the client).
 *      - terminal failure (no charge) → intent FAILED, proposal FAILED.
 *      - uncertain (timeout/unavailable/network-down/server-error/
 *        client-disconnect/ambiguous) → intent UNKNOWN, proposal left
 *        EXECUTING; a later reconcileIntent() settles it exactly once.
 *
 * All timestamps are ISO-UTC derived from an explicit nowMs (no Date.now()).
 */

import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { isoUtc, paise } from "@arbiter/shared";

import { transition } from "../approval/state_machine.js";
import { idempotencyKey, rzpRequestRef } from "./index.js";

/* ── provider contract (rich enough to express real PSP behaviors) ─ */

export type ProviderStatus =
  | "succeeded"
  | "insufficient_funds"
  | "network_down"
  | "timeout"
  | "unavailable"
  | "invalid_details"
  | "expired_method"
  | "duplicate"
  | "cancelled"
  | "rejected"
  | "auth_expired"
  | "server_error"
  | "client_disconnect"
  | "lost_response"
  | "ambiguous"
  | "rate_limited"
  | "slow_network"
  | "concurrent";

export interface ChargeInput {
  clientIdemKey: string;
  proposalId: string;
  actionId: string;
  failureClass: string;
  amountPaise: number;
  tenantId: string;
  scenario: string;
  nowMs: number;
}

export interface ChargeResult {
  status: ProviderStatus;
  /** Did the response reach the client? false ⇒ the "lost response" hazard. */
  delivered: boolean;
  chargeId?: string;
  latencyMs: number;
  /** Safe, external-facing code (never an internal error). */
  errorCode?: string;
  /** Safe, external-facing message (never a stack trace). */
  errorMessage?: string;
}

export interface ChargeProvider {
  readonly name: string;
  charge(input: ChargeInput): Promise<ChargeResult>;
}

/* ── outcome classification ─────────────────────────────────────── */

const TERMINAL_SUCCESS: ReadonlySet<ProviderStatus> = new Set(["succeeded", "lost_response", "slow_network"]);
const TERMINAL_FAIL: ReadonlySet<ProviderStatus> = new Set([
  "insufficient_funds",
  "invalid_details",
  "expired_method",
  "rejected",
  "cancelled",
  "auth_expired",
  "rate_limited",
  "duplicate",
]);
const UNCERTAIN: ReadonlySet<ProviderStatus> = new Set([
  "timeout",
  "unavailable",
  "network_down",
  "server_error",
  "client_disconnect",
  "ambiguous",
  "concurrent",
]);

export type ClientVisible =
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN"
  | "ALREADY_SUBMITTED"
  | "CANCELLED"
  | "PROCESSING";

export interface PaymentIntentResult {
  clientIdemKey: string;
  clientVisible: ClientVisible;
  intentState: "PROCESSING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "UNKNOWN";
  chargeId?: string;
  idempotent: boolean;
  reExecuted: boolean;
  proposalId: string;
  actionId: string;
  ledgerBalanceAfterPaise?: number;
  errorCode?: string;
  errorMessage?: string;
}

/* ── ledger helpers (idempotent debits) ─────────────────────────── */

export async function getBalance(client: Client, customerId: string): Promise<number> {
  const r = await client.execute({
    sql: `SELECT balance_paise FROM account_balances WHERE customer_id = ?`,
    args: [customerId],
  });
  return r.rows.length > 0 ? Number((r.rows[0] as unknown as { balance_paise: number }).balance_paise) : 0;
}

/**
 * Debit the sandbox balance exactly once per idempotency key. A retried
 * collection reuses the same key, so the balance is never reduced twice —
 * this is what prevents the double-charge even when the provider is retried.
 */
export async function debitLedger(
  client: Client,
  customerId: string,
  idemKey: string,
  amountPaise: number,
  nowMs: number,
): Promise<number> {
  const existing = await client.execute({
    sql: `SELECT id FROM ledger_entries WHERE idem_key = ? AND kind = 'DEBIT'`,
    args: [idemKey],
  });
  if (existing.rows.length > 0) {
    return getBalance(client, customerId);
  }
  const nowIso = isoUtc(nowMs);
  const before = await getBalance(client, customerId);
  const after = Math.max(0, before - amountPaise);

  await client.batch(
    [
      {
        sql: `INSERT INTO ledger_entries (id, customer_id, idem_key, kind, amount_paise, balance_after_paise, at_utc)
              VALUES (?, ?, ?, 'DEBIT', ?, ?, ?)
              ON CONFLICT(idem_key, kind) DO NOTHING`,
        args: [`led_${idemKey}`, customerId, idemKey, amountPaise, after, nowIso],
      },
      {
        sql: `INSERT INTO account_balances (customer_id, balance_paise, updated_at_utc)
              VALUES (?, ?, ?)
              ON CONFLICT(customer_id) DO UPDATE SET balance_paise = excluded.balance_paise, updated_at_utc = excluded.updated_at_utc`,
        args: [customerId, after, nowIso],
      },
    ],
    "write",
  );
  return after;
}

/* ── intent lookup ──────────────────────────────────────────────── */

export async function findIntent(client: Client, clientIdemKey: string, tenantId?: string) {
  const sql = tenantId
    ? `SELECT * FROM payment_intents WHERE client_idem_key = ? AND tenant_id = ?`
    : `SELECT * FROM payment_intents WHERE client_idem_key = ?`;
  const args = tenantId ? [clientIdemKey, tenantId] : [clientIdemKey];
  const r = await client.execute({ sql, args });
  return r.rows.length > 0 ? mapIntent(r.rows[0] as unknown as Record<string, unknown>) : null;
}

export function computeCanonicalPayloadHash(payload: Record<string, unknown>): string {
  const sortedKeys = Object.keys(payload).sort();
  const canonicalObj: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    canonicalObj[k] = payload[k];
  }
  return createHash("sha256").update(JSON.stringify(canonicalObj)).digest("hex");
}


function mapIntent(row: Record<string, unknown>): IntentRow {
  return {
    id: String(row.id),
    clientIdemKey: String(row.client_idem_key),
    proposalId: String(row.proposal_id),
    customerId: String(row.customer_id),
    tenantId: String(row.tenant_id),
    amountPaise: Number(row.amount_paise),
    status: row.status as IntentRow["status"],
    clientVisible: (row.client_visible as ClientVisible | null) ?? null,
    chargeId: (row.charge_id as string | null) ?? null,
    scenario: (row.scenario as string | null) ?? null,
    createdAtUtc: String(row.created_at_utc),
    resolvedAtUtc: (row.resolved_at_utc as string | null) ?? null,
  };
}

interface IntentRow {
  id: string;
  clientIdemKey: string;
  proposalId: string;
  customerId: string;
  tenantId: string;
  amountPaise: number;
  status: "PROCESSING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "UNKNOWN";
  clientVisible: ClientVisible | null;
  chargeId: string | null;
  scenario: string | null;
  createdAtUtc: string;
  resolvedAtUtc: string | null;
}

interface ProposalRow {
  id: string;
  event_id: string;
  state: string;
  customer_id: string;
  model_version_id: string;
  policy_version: string;
  action_json: string;
  ev_paise: number;
}

async function fetchProposal(client: Client, proposalId: string): Promise<ProposalRow | null> {
  const r = await client.execute({
    sql: `SELECT id, event_id, state, customer_id, model_version_id, policy_version, action_json, ev_paise
          FROM proposals WHERE id = ?`,
    args: [proposalId],
  });
  return r.rows.length > 0 ? (r.rows[0] as unknown as ProposalRow) : null;
}

function settledResult(
  intent: IntentRow,
  proposal: ProposalRow,
  idempotent: boolean,
  reExecuted: boolean,
): PaymentIntentResult {
  const map: Record<IntentRow["status"], ClientVisible> = {
    SUCCEEDED: "SUCCEEDED",
    FAILED: "FAILED",
    CANCELLED: "CANCELLED",
    UNKNOWN: "UNKNOWN",
    PROCESSING: "PROCESSING",
  };
  return {
    clientIdemKey: intent.clientIdemKey,
    clientVisible: (intent.clientVisible as ClientVisible) ?? map[intent.status],
    intentState: intent.status,
    chargeId: intent.chargeId ?? undefined,
    idempotent,
    reExecuted,
    proposalId: proposal.id,
    actionId: JSON.parse(proposal.action_json).action,
  };
}

/* ── core: executePaymentIntent ─────────────────────────────────── */

export interface ExecuteIntentInput {
  clientIdemKey: string;
  proposalId: string;
  scenario: string;
  provider: ChargeProvider;
  nowMs: number;
  /** Skip the approval-state pre-check (used by tests that pre-set EXECUTING). */
  allowExecuting?: boolean;
}

/**
 * Execute a recovery collection as an idempotent payment intent.
 * See module docstring for the full lifecycle.
 */
export async function executePaymentIntent(
  client: Client,
  input: ExecuteIntentInput,
): Promise<PaymentIntentResult> {
  const { clientIdemKey, proposalId, scenario, provider, nowMs } = input;

  const p = await fetchProposal(client, proposalId);
  if (!p) throw new Error("executePaymentIntent: UNKNOWN_PROPOSAL");

  // 1. Idempotency FIRST: any prior intent (terminal OR in-flight) short-circuits
  //    before we ever re-check proposal state. This is what prevents a double
  //    charge when a retry arrives after the proposal was already moved to
  //    EXECUTING by an earlier uncertain/timeout attempt.
  const prior = await findIntent(client, clientIdemKey);
  if (prior) {
    return settledResult(prior, p, true, false);
  }

  if (!input.allowExecuting && p.state !== "APPROVED" && p.state !== "AUTO_APPROVED") {
    throw new Error(`executePaymentIntent: proposal in state ${p.state}, not APPROVED/AUTO_APPROVED`);
  }

  // 2. Create the intent (single-flight via UNIQUE(client_idem_key)).
  const id = `pint_${clientIdemKey}`;
  const chargeId = `ch_${clientIdemKey}`;
  try {
    await client.execute({
      sql: `INSERT INTO payment_intents
              (id, client_idem_key, proposal_id, customer_id, tenant_id, amount_paise, status, charge_id, scenario, created_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, 'PROCESSING', ?, ?, ?)`,
      args: [id, clientIdemKey, proposalId, p.customer_id, "", paise(Number(0)), "PROCESSING", chargeId, scenario, isoUtc(nowMs)],
    });
  } catch {
    // Another concurrent call won the insert → treat as already submitted.
    const race = await findIntent(client, clientIdemKey);
    if (race) return settledResult(race, p, true, false);
    throw new Error("executePaymentIntent: intent insert failed");
  }

  // tenant_id + amount from the event row
  const ev = await client.execute({
    sql: `SELECT amount_paise, tenant_id FROM payment_events WHERE id = ?`,
    args: [p.event_id],
  });
  const evRow = ev.rows[0] as unknown as { amount_paise: number; tenant_id: string };
  const amountPaise = paise(Number(evRow.amount_paise));
  const tenantId = String(evRow.tenant_id);
  await client.execute({
    sql: `UPDATE payment_intents SET tenant_id = ?, amount_paise = ? WHERE id = ?`,
    args: [tenantId, amountPaise, id],
  });

  const actionId = (JSON.parse(p.action_json) as { action: string }).action;

  // 3. Run the provider (wrapped so a thrown error is an uncertain outcome).
  let result: ChargeResult;
  try {
    result = await provider.charge({
      clientIdemKey,
      proposalId,
      actionId,
      failureClass: (JSON.parse(p.action_json) as { failureClass?: string }).failureClass ?? "UNKNOWN",
      amountPaise,
      tenantId,
      scenario,
      nowMs,
    });
  } catch (err) {
    result = {
      status: "server_error",
      delivered: false,
      latencyMs: 0,
      errorCode: "RZP_PROVIDER_ERROR",
      errorMessage: "The payment provider is temporarily unavailable.",
    };
  }

  // 4. Resolve
  const nowIso = isoUtc(nowMs);

  if (TERMINAL_SUCCESS.has(result.status)) {
    const balanceAfter = await debitLedger(client, p.customer_id, clientIdemKey, amountPaise, nowMs);
    await client.execute({
      sql: `UPDATE payment_intents SET status='SUCCEEDED', charge_id=?, client_visible=?, resolved_at_utc=? WHERE id=?`,
      args: [result.chargeId ?? chargeId, result.delivered ? "SUCCEEDED" : "UNKNOWN", nowIso, id],
    });
    await writeActionRow(client, proposalId, actionId, "SUCCEEDED", nowMs);
    await transition(client, { proposalId, toState: "EXECUTED", actor: "SYSTEM", note: `${actionId} succeeded`, nowMs });
    await auditAction(client, tenantId, p.event_id, proposalId, actionId, "SUCCEEDED", clientIdemKey, result.chargeId ?? chargeId, nowMs, { errorCode: result.errorCode, delivered: result.delivered });
    return {
      clientIdemKey,
      clientVisible: result.delivered ? "SUCCEEDED" : "UNKNOWN",
      intentState: "SUCCEEDED",
      chargeId: result.chargeId ?? chargeId,
      idempotent: false,
      reExecuted: true,
      proposalId,
      actionId,
      ledgerBalanceAfterPaise: balanceAfter,
      errorCode: result.errorCode,
    };
  }

  if (TERMINAL_FAIL.has(result.status)) {
    // A provider "duplicate" means this request is a replay of an already
    // collected original → surface it as the original's success (idempotent),
    // never as a fresh failure that would block reconciliation.
    const isDuplicate = result.status === "duplicate";
    const isCancel = result.status === "cancelled";
    const intentState = isDuplicate ? "SUCCEEDED" : isCancel ? "CANCELLED" : "FAILED";
    const clientVisible = isDuplicate ? "SUCCEEDED" : isCancel ? "CANCELLED" : "FAILED";
    if (isDuplicate) {
      const balanceAfter = await debitLedger(client, p.customer_id, clientIdemKey, amountPaise, nowMs);
      await client.execute({
        sql: `UPDATE payment_intents SET status='SUCCEEDED', charge_id=?, client_visible='SUCCEEDED', resolved_at_utc=? WHERE id=?`,
        args: [result.chargeId ?? chargeId, nowIso, id],
      });
      await writeActionRow(client, proposalId, actionId, "SUCCEEDED", nowMs);
      await transition(client, { proposalId, toState: "EXECUTED", actor: "SYSTEM", note: `${actionId} duplicate (already collected)`, nowMs });
      await auditAction(client, tenantId, p.event_id, proposalId, actionId, "SUCCEEDED", clientIdemKey, result.chargeId ?? chargeId, nowMs, { errorCode: result.errorCode, delivered: result.delivered });
      return {
        clientIdemKey,
        clientVisible,
        intentState,
        chargeId: result.chargeId ?? chargeId,
        idempotent: false,
        reExecuted: true,
        proposalId,
        actionId,
        ledgerBalanceAfterPaise: balanceAfter,
        errorCode: result.errorCode,
      };
    }
    await client.execute({
      sql: `UPDATE payment_intents SET status=?, client_visible=?, resolved_at_utc=? WHERE id=?`,
      args: [intentState, intentState, nowIso, id],
    });
    await writeActionRow(client, proposalId, actionId, "FAILED", nowMs);
    await transition(client, { proposalId, toState: "FAILED", actor: "SYSTEM", note: `${actionId} failed: ${result.errorCode ?? result.status}`, nowMs });
    await auditAction(client, tenantId, p.event_id, proposalId, actionId, intentState, clientIdemKey, result.chargeId ?? chargeId, nowMs, { errorCode: result.errorCode, errorMessage: result.errorMessage });
    return {
      clientIdemKey,
      clientVisible,
      intentState,
      chargeId: result.chargeId ?? chargeId,
      idempotent: false,
      reExecuted: true,
      proposalId,
      actionId,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    };
  }

  // UNCERTAIN (timeout/unavailable/network-down/server-error/client-disconnect/ambiguous/concurrent)
  await client.execute({
    sql: `UPDATE payment_intents SET status='UNKNOWN', client_visible='UNKNOWN', resolved_at_utc=? WHERE id=?`,
    args: [nowIso, id],
  });
  await writeActionRow(client, proposalId, actionId, "PENDING", nowMs);
  // Leave the proposal EXECUTING for later reconciliation.
  if ((await fetchProposal(client, proposalId))?.state === "APPROVED" || (await fetchProposal(client, proposalId))?.state === "AUTO_APPROVED") {
    await transition(client, { proposalId, toState: "EXECUTING", actor: "SYSTEM", note: `${actionId} uncertain: ${result.status}`, nowMs });
  }
  await auditAction(client, tenantId, p.event_id, proposalId, actionId, "UNKNOWN", clientIdemKey, result.chargeId ?? chargeId, nowMs, { errorCode: result.errorCode, status: result.status });
  return {
    clientIdemKey,
    clientVisible: "UNKNOWN",
    intentState: "UNKNOWN",
    chargeId: result.chargeId ?? chargeId,
    idempotent: false,
    reExecuted: true,
    proposalId,
    actionId,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
  };
}

/* ── reconcile an uncertain intent (simulates a provider webhook) ── */

/**
 * Settle a PROCESSING/UNKNOWN intent when the provider later confirms. Applies
 * the debit at most once (idempotent), so reconciliation + a client retry can
 * both happen without double-charging.
 */
export async function reconcileIntent(
  client: Client,
  clientIdemKey: string,
  outcome: "SUCCEEDED" | "FAILED",
  nowMs: number,
): Promise<PaymentIntentResult | null> {
  const intent = await findIntent(client, clientIdemKey);
  if (!intent) return null;
  if (intent.status === "SUCCEEDED" || intent.status === "FAILED" || intent.status === "CANCELLED") {
    const p = await fetchProposal(client, intent.proposalId);
    return p ? settledResult(intent, p, true, false) : null;
  }

  const nowIso = isoUtc(nowMs);
  if (outcome === "SUCCEEDED") {
    const balanceAfter = await debitLedger(client, intent.customerId, clientIdemKey, intent.amountPaise, nowMs);
    await client.execute({
      sql: `UPDATE payment_intents SET status='SUCCEEDED', client_visible='SUCCEEDED', resolved_at_utc=? WHERE id=?`,
      args: [nowIso, intent.id],
    });
    await writeActionRow(client, intent.proposalId, "RECOVERY", "SUCCEEDED", nowMs);
    await transition(client, { proposalId: intent.proposalId, toState: "EXECUTED", actor: "SYSTEM", note: "reconciled SUCCEEDED", nowMs });
    return {
      clientIdemKey,
      clientVisible: "SUCCEEDED",
      intentState: "SUCCEEDED",
      chargeId: intent.chargeId ?? undefined,
      idempotent: false,
      reExecuted: true,
      proposalId: intent.proposalId,
      actionId: "RECOVERY",
      ledgerBalanceAfterPaise: balanceAfter,
    };
  }
  await client.execute({
    sql: `UPDATE payment_intents SET status='FAILED', client_visible='FAILED', resolved_at_utc=? WHERE id=?`,
    args: [nowIso, intent.id],
  });
  await writeActionRow(client, intent.proposalId, "RECOVERY", "FAILED", nowMs);
  await transition(client, { proposalId: intent.proposalId, toState: "FAILED", actor: "SYSTEM", note: "reconciled FAILED", nowMs });
  return {
    clientIdemKey,
    clientVisible: "FAILED",
    intentState: "FAILED",
    idempotent: false,
    reExecuted: true,
    proposalId: intent.proposalId,
    actionId: "RECOVERY",
  };
}

/* ── small row helpers ──────────────────────────────────────────── */

async function writeActionRow(
  client: Client,
  proposalId: string,
  actionId: string,
  outcome: "PENDING" | "SUCCEEDED" | "FAILED",
  nowMs: number,
) {
  const nowIso = isoUtc(nowMs);
  await client.execute({
    sql: `INSERT INTO actions (id, proposal_id, idempotency_key, executor, payload_json, rzp_request_ref, outcome, executed_at_utc)
          VALUES (?, ?, ?, 'intent', '{}', ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET outcome = excluded.outcome, executed_at_utc = excluded.executed_at_utc`,
    args: [`act-${proposalId}`, proposalId, idempotencyKey(proposalId, "intent", "v1", actionId), rzpRequestRef(proposalId, actionId), outcome, nowIso],
  });
}

async function auditAction(
  client: Client,
  tenantId: string,
  eventId: string,
  proposalId: string,
  action: string,
  outcome: string,
  idemKey: string,
  ref: string,
  nowMs: number,
  extra: Record<string, unknown>,
) {
  await client.execute({
    sql: `INSERT INTO audit_log (ts_utc, tenant_id, event_id, actor, entry_type, payload_json)
          VALUES (?, ?, ?, 'SYSTEM', 'ACTION', ?)`,
    args: [isoUtc(nowMs), tenantId, eventId, JSON.stringify({ proposalId, action, outcome, idempotencyKey: idemKey, rzpRequestRef: ref, ...extra })],
  });
}
