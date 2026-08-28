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
import { isoUtc, paise } from "@arbiter/shared";
import { transition } from "../approval/state_machine.js";
import { multiplierFor, type ActionId, type FailureClassId } from "../decide/catalog.js";
import { STALE_EXECUTION_MINUTES } from "../constants.js";

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
 * Same inputs → same output.  Uses the catalog multiplier table directly —
 * no duplication, single source of truth.
 *
 *   multiplier 0  →  DEAD action for this class  →  FAILED
 *   multiplier > 0  →  viable  →  SUCCEEDED
 *   HUMAN_REVIEW  →  always AMBIGUOUS (needs a human)
 */
function deterministicOutcome(
  actionId: string,
  failureClass: string,
  _evPaise: number,
  _amountPaise: number,
): ExecutionOutcome {
  // HUMAN_REVIEW always needs a human — never auto-resolved
  if (actionId === "HUMAN_REVIEW") return "AMBIGUOUS";

  // Use the catalog multiplier directly (single source of truth)
  const mult = multiplierFor(failureClass as FailureClassId, actionId as ActionId);

  // Dead action for this class → FAILED (the multiplier-is-zero path)
  if (mult === 0) return "FAILED";

  // Viable action → SUCCEEDED (the test-API call is a deterministic stub)
  return "SUCCEEDED";
}

/* ── row helpers (cast-through-unknown pattern from codebase) ───── */

interface ProposalRow {
  id: string;
  event_id: string;
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
    sql: `SELECT id, event_id, state, state_version, customer_id, model_version_id, policy_version,
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

  // 2. Parse action from the proposal (failureClass is the PIPELINE-COMPUTED
  //    class, not the untrusted seed hint — see pipeline.ts action_json).
  const chosen = JSON.parse(p.action_json) as {
    action: string;
    evPaise: number;
    failureClass: string;
  };
  const actionId = chosen.action;
  const evPaise = chosen.evPaise;

  // 3. Fetch event row for failure class, amount, AND tenant_id (needed for audit_log)
  const evRow = await client.execute({
    sql: `SELECT failure_class_hint, amount_paise, e.tenant_id
          FROM payment_events e
          JOIN proposals p ON p.event_id = e.id
          WHERE p.id = ?`,
    args: [proposalId],
  });
  if (evRow.rows.length === 0) {
    throw new Error("executor: MISSING_EVENT — proposal references non-existent event");
  }
  // Prefer the computed class from action_json; fall back to the seed hint only
  // if the proposal predates this fix.
  const failureClass =
    chosen.failureClass ?? String(evRow.rows[0]!.failure_class_hint ?? "UNKNOWN");
  const amountPaise = paise(Number(evRow.rows[0]!.amount_paise));
  const tenantId = String(evRow.rows[0]!.tenant_id);

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
    nowMs,
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
    nowMs,
  });

  // 9. Audit trail — ACTION ledger row (uses correct tenant_id from payment_events)
  await client.execute({
    sql: `INSERT INTO audit_log (ts_utc, tenant_id, event_id, actor, entry_type, payload_json)
          VALUES (?, ?, ?, 'SYSTEM', 'ACTION', ?)`,
    args: [
      nowIso,
      tenantId,
      p.event_id,
      JSON.stringify({
        proposalId,
        action: actionId,
        outcome,
        idempotencyKey: idemKey,
        rzpRequestRef: ref,
        evPaise,
      }),
    ],
  });

  return { outcome, actionId, proposalId, rzpRequestRef: ref, idempotencyKey: idemKey };
}

/* ── reconcile: for stuck EXECUTING proposals ──────────────────── */

/**
 * Reconcile a proposal stuck in EXECUTING.  Updates the actions table
 * for PENDING rows and forces the proposal to the right terminal.
 * Used by the recovery sweep when a network call times out.
 *
 * Returns null if the proposal is already terminal or doesn't exist.
 * Returns null if the action row was already updated (no-op race).
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

  // Update the action row — only if still PENDING (concurrent reconcile guard)
  const updateResult = await client.execute({
    sql: `UPDATE actions SET outcome = ?, executed_at_utc = ?
          WHERE proposal_id = ? AND outcome = 'PENDING'`,
    args: [outcome, nowIso, proposalId],
  });

  // If no action row was updated, the action was already resolved — skip
  if ((updateResult.rowsAffected ?? 0) === 0) return null;

  // Transition proposal
  const t = await transition(client, {
    proposalId,
    toState: finalState,
    actor: "SYSTEM",
    note: `reconciled to ${outcome.toLowerCase()}`,
    nowMs,
  });
  if (!t.ok) return null;

  // Audit trail — resolve tenant_id through payment_events
  const chosen = JSON.parse(p.action_json) as { action: string };
  const evRow = await client.execute({
    sql: `SELECT e.tenant_id, p.event_id
          FROM payment_events e JOIN proposals p ON p.event_id = e.id
          WHERE p.id = ?`,
    args: [proposalId],
  });
  const tenantId = String(evRow.rows[0]?.tenant_id ?? "demo");
  const eventId = String(evRow.rows[0]?.event_id ?? "");

  await client.execute({
    sql: `INSERT INTO audit_log (ts_utc, tenant_id, event_id, actor, entry_type, payload_json)
          VALUES (?, ?, ?, 'SYSTEM', 'ACTION', ?)`,
    args: [
      nowIso,
      tenantId,
      eventId,
      JSON.stringify({
        proposalId,
        action: chosen.action,
        outcome,
        reconciled: true,
      }),
    ],
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
  staleMinutes = STALE_EXECUTION_MINUTES,
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
