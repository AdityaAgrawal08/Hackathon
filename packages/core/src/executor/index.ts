/**
 * P5 — Executor service (the most important function in the codebase).
 *
 * Determinism barrier: same (proposalId, nowMs) → same idempotency key →
 * same outcome → same DB state.  No Date.now(), no Math.random(), no
 * external latency leakage.
 *
 * Execution lifecycle:
 *   APPROVED / AUTO_APPROVED  →  claim idempotency key  →  EXECUTING
 *   →  run action  →  EXECUTED / FAILED
 */

import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { isoUtc } from "@arbiter/shared";
import { transition } from "../approval/state_machine.js";

/* ── types ─────────────────────────────────────────────────────── */

export type ExecutionOutcome = "SUCCEEDED" | "FAILED" | "AMBIGUOUS";

export interface ExecuteResult {
  outcome: ExecutionOutcome;
  actionId: string;
  proposalId: string;
  rzpRequestRef: string;
  idempotencyKey: string;
}

export interface ExecuteInput {
  proposalId: string;
  nowMs: number;
}

export interface ReconcileInput {
  proposalId: string;
  nowMs: number;
  /** Force the final outcome (for reconciliation). */
  outcome: ExecutionOutcome;
}

/* ── idempotency ───────────────────────────────────────────────── */

/**
 * Deterministic idempotency key: SHA256(proposalId, modelVersionId,
 * policyVersion, action_json) — the immutable data that defines a
 * proposal.  The same proposal always produces the same key.
 */
export function idempotencyKey(
  proposalId: string,
  modelVersionId: string,
  policyVersion: string,
  actionJson: string,
): string {
  const raw = `${proposalId}:${modelVersionId}:${policyVersion}:${actionJson}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/** Deterministic Razorpay request reference (not from Date.now()). */
export function rzpRequestRef(proposalId: string, actionId: string): string {
  const raw = `rzp:${proposalId}:${actionId}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

/* ── per-action outcome logic (the determinism barrier) ─────────── */

/**
 * Pure function: (actionId, failureClass, evPaise, amountPaise) → outcome.
 * Same inputs → same output.  Mirrors the catalog multiplier matrix:
 *   multiplier 0  →  DEAD action for this class  →  FAILED
 *   multiplier > 0  →  viable  →  SUCCEEDED
 *   HUMAN_REVIEW  →  always AMBIGUOUS (needs a human)
 */
function deterministicOutcome(
  actionId: string,
  failureClass: string,
  evPaise: number,
  amountPaise: number,
): ExecutionOutcome {
  // Multiplier table (from catalog.ts — same values, no import to avoid cycle)
  const MULT: Record<string, Record<string, number>> = {
    SOFT_RETRYABLE: { RETRY_NOW: 0.6, RETRY_PAYDAY: 1.4, ALTERNATE_UPI_LINK: 0.5, REMINDER_LINK: 0.7, HUMAN_REVIEW: 0.3, NO_ACTION: 0.02 },
    HARD_METHOD_DEAD: { RETRY_NOW: 0.0, RETRY_PAYDAY: 0.0, ALTERNATE_UPI_LINK: 1.0, REMINDER_LINK: 0.6, HUMAN_REVIEW: 0.1, NO_ACTION: 0.0 },
    NETWORK_TIMEOUT: { RETRY_NOW: 1.5, RETRY_PAYDAY: 0.4, ALTERNATE_UPI_LINK: 0.3, REMINDER_LINK: 0.2, HUMAN_REVIEW: 0.05, NO_ACTION: 0.05 },
    RISK_FLAGGED: { RETRY_NOW: 0.0, RETRY_PAYDAY: 0.0, ALTERNATE_UPI_LINK: 0.0, REMINDER_LINK: 0.0, HUMAN_REVIEW: 1.0, NO_ACTION: 0.0 },
    UNKNOWN: { RETRY_NOW: 0.1, RETRY_PAYDAY: 0.1, ALTERNATE_UPI_LINK: 0.1, REMINDER_LINK: 0.1, HUMAN_REVIEW: 1.0, NO_ACTION: 0.0 },
  };

  const mult = MULT[failureClass]?.[actionId] ?? 0;

  // HUMAN_REVIEW always needs a human — never auto-resolved
  if (actionId === "HUMAN_REVIEW") return "AMBIGUOUS";

  // Dead action for this class → FAILED (the multiplier-is-zero path)
  if (mult === 0) return "FAILED";

  // Viable action → SUCCEEDED (the test-API call is a deterministic stub)
  return "SUCCEEDED";
}

/* ── row helpers (cast-through-unknown pattern from codebase) ───── */

interface ProposalRow {
  id: string;
  state: string;
  state_version: number;
  customer_id: string;
  model_version_id: string;
  policy_version: string;
  action_json: string;
  ev_paise: number;
}

async function fetchProposal(client: Client, proposalId: string): Promise<ProposalRow | null> {
  const r = await client.execute({
    sql: `SELECT id, state, state_version, customer_id, model_version_id, policy_version,
                 action_json, ev_paise
          FROM proposals WHERE id = ?`,
    args: [proposalId],
  });
  return r.rows.length > 0 ? (r.rows[0] as unknown as ProposalRow) : null;
}

/* ── core: executeProposal ─────────────────────────────────────── */

/**
 * Execute an approved proposal.
 *
 * Pre-conditions (enforced):
 *   - proposal must exist
 *   - state must be APPROVED or AUTO_APPROVED
 *
 * Post-conditions (on success):
 *   - proposal state → EXECUTED (SUCCEEDED) or FAILED (FAILED)
 *   - actions row inserted with outcome + idempotency key
 *   - audit_log ACTION row written
 *
 * Determinism: same proposalId + same nowMs → identical DB state.
 */
export async function executeProposal(
  client: Client,
  input: ExecuteInput,
): Promise<ExecuteResult> {
  const { proposalId, nowMs } = input;

  // 1. Fetch proposal
  const p = await fetchProposal(client, proposalId);
  if (!p) throw new Error("executor: UNKNOWN_PROPOSAL");
  if (p.state !== "APPROVED" && p.state !== "AUTO_APPROVED") {
    throw new Error(`executor: proposal in state ${p.state}, not APPROVED/AUTO_APPROVED`);
  }

  // 2. Parse action from the proposal
  const chosen = JSON.parse(p.action_json) as { action: string; evPaise: number };
  const actionId = chosen.action;
  const evPaise = chosen.evPaise;

  // 3. Need the event row for failure class and amount
  const evRow = await client.execute({
    sql: `SELECT failure_class_hint, amount_paise FROM payment_events
          JOIN proposals ON proposals.event_id = payment_events.id
          WHERE proposals.id = ?`,
    args: [proposalId],
  });
  const failureClass = String(evRow.rows[0]?.failure_class_hint ?? "UNKNOWN");
  const amountPaise = Number(evRow.rows[0]?.amount_paise ?? 0);

  // 4. Generate deterministic idempotency key
  const idemKey = idempotencyKey(proposalId, p.model_version_id, p.policy_version, p.action_json);
  const ref = rzpRequestRef(proposalId, actionId);

  // 5. Claim idempotency key BEFORE any side-effect (insert → fail if duplicate)
  await client.execute({
    sql: `INSERT INTO actions (id, proposal_id, idempotency_key, executor, payload_json, rzp_request_ref, outcome, executed_at_utc)
          VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
    args: [
      `act-${proposalId}`,
      proposalId,
      idemKey,
      actionId,
      JSON.stringify({ action: actionId, evPaise, amountPaise, failureClass }),
      ref,
      isoUtc(nowMs),
    ],
  });

  // 6. Transition to EXECUTING
  const t = await transition(client, {
    proposalId,
    toState: "EXECUTING",
    actor: "SYSTEM",
    note: `executing ${actionId} (idem: ${idemKey})`,
  });
  if (!t.ok) {
    // Concurrent modification — abort, leave PENDING action row for reconcile
    throw new Error(`executor: CONCURRENT_MODIFICATION on ${proposalId}`);
  }

  // 7. Run the deterministic action (the determinism barrier)
  const outcome = deterministicOutcome(actionId, failureClass, evPaise, amountPaise);

  // 8. Record outcome
  const finalState = outcome === "SUCCEEDED" ? "EXECUTED" : "FAILED";
  const nowIso = isoUtc(nowMs);

  await client.execute({
    sql: `UPDATE actions SET outcome = ?, executed_at_utc = ? WHERE id = ?`,
    args: [outcome, nowIso, `act-${proposalId}`],
  });

  await transition(client, {
    proposalId,
    toState: finalState,
    actor: "SYSTEM",
    note: `${actionId} ${outcome.toLowerCase()}`,
  });

  // 9. Audit trail — ACTION ledger row
  await client.execute({
    sql: `INSERT INTO audit_log (ts_utc, tenant_id, event_id, actor, entry_type, payload_json)
          SELECT ?, p2.customer_id, p2.event_id, 'SYSTEM', 'ACTION',
                 json_object(
                   'proposalId', p2.id,
                   'action', ?,
                   'outcome', ?,
                   'idempotencyKey', ?,
                   'rzpRequestRef', ?,
                   'evPaise', p2.ev_paise
                 )
          FROM proposals p2 WHERE p2.id = ?`,
    args: [nowIso, actionId, outcome, idemKey, ref, proposalId],
  });

  return { outcome, actionId, proposalId, rzpRequestRef: ref, idempotencyKey: idemKey };
}

/* ── reconcile: for stuck EXECUTING proposals ──────────────────── */

/**
 * Reconcile a proposal stuck in EXECUTING.  Scans the actions table
 * for the latest outcome and forces the proposal to the right terminal.
 * Used by the recovery sweep when a network call times out.
 */
export async function reconcileProposal(
  client: Client,
  input: ReconcileInput,
): Promise<ExecuteResult | null> {
  const { proposalId, nowMs, outcome } = input;

  const p = await fetchProposal(client, proposalId);
  if (!p) return null;
  if (p.state !== "EXECUTING") return null;

  const nowIso = isoUtc(nowMs);
  const finalState = outcome === "SUCCEEDED" ? "EXECUTED" : "FAILED";

  // Update the action row
  await client.execute({
    sql: `UPDATE actions SET outcome = ?, executed_at_utc = ?
          WHERE proposal_id = ? AND outcome = 'PENDING'`,
    args: [outcome, nowIso, proposalId],
  });

  // Transition proposal
  const t = await transition(client, {
    proposalId,
    toState: finalState,
    actor: "SYSTEM",
    note: `reconciled to ${outcome.toLowerCase()}`,
  });
  if (!t.ok) return null;

  // Audit trail
  const chosen = JSON.parse(p.action_json) as { action: string };
  await client.execute({
    sql: `INSERT INTO audit_log (ts_utc, tenant_id, event_id, actor, entry_type, payload_json)
          SELECT ?, p2.customer_id, p2.event_id, 'SYSTEM', 'ACTION',
                 json_object('proposalId', p2.id, 'action', ?, 'outcome', ?, 'reconciled', 1)
          FROM proposals p2 WHERE p2.id = ?`,
    args: [nowIso, chosen.action, outcome, proposalId],
  });

  return {
    outcome,
    actionId: chosen.action,
    proposalId,
    rzpRequestRef: "",
    idempotencyKey: "",
  };
}

/* ── sweep: find stuck EXECUTING proposals ─────────────────────── */

/**
 * Recovery sweep: find proposals stuck in EXECUTING for more than
 * `staleMinutes` and reconcile them.  Returns the number reconciled.
 */
export async function sweepStuckExecutions(
  client: Client,
  nowMs: number,
  staleMinutes = 5,
): Promise<number> {
  const cutoffIso = isoUtc(nowMs - staleMinutes * 60_000);
  const stuck = await client.execute({
    sql: `SELECT id FROM proposals
          WHERE state = 'EXECUTING' AND updated_at_utc < ?`,
    args: [cutoffIso],
  });

  let count = 0;
  for (const row of stuck.rows) {
    const id = String(row.id);
    const r = await reconcileProposal(client, {
      proposalId: id,
      nowMs,
      outcome: "AMBIGUOUS", // conservatively mark as ambiguous on timeout
    });
    if (r) count++;
  }
  return count;
}

/* ── bulk: execute all APPROVED/AUTO_APPROVED proposals ────────── */

export interface BulkResult {
  executed: number;
  succeeded: number;
  failed: number;
  ambiguous: number;
  errors: string[];
}

/**
 * Execute all proposals in APPROVED or AUTO_APPROVED state.
 * Used by `pnpm execute` and the test harness.
 */
export async function executeAll(
  client: Client,
  nowMs: number,
): Promise<BulkResult> {
  const pending = await client.execute({
    sql: `SELECT id FROM proposals
          WHERE state IN ('APPROVED', 'AUTO_APPROVED')
          ORDER BY ev_paise DESC, id ASC`,
  });

  const result: BulkResult = { executed: 0, succeeded: 0, failed: 0, ambiguous: 0, errors: [] };

  for (const row of pending.rows) {
    const id = String(row.id);
    try {
      const r = await executeProposal(client, { proposalId: id, nowMs });
      result.executed++;
      if (r.outcome === "SUCCEEDED") result.succeeded++;
      else if (r.outcome === "FAILED") result.failed++;
      else result.ambiguous++;
    } catch (err) {
      result.errors.push(`${id}: ${(err as Error).message}`);
    }
  }

  return result;
}
