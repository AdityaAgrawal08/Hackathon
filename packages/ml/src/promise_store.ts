/**
 * §4.7 Promise-to-pay behavioral loop.
 *
 * When the optimizer picks PROMISE_TO_PAY, the pipeline records a promise in
 * `promise_to_pay`. Promises are reconciled (KEPT / BROKEN) by the merchant's
 * later payment events; the kept-rate becomes a per-customer behavioral feature
 * (`promise_kept_rate`) that feeds the next decision (a customer who keeps their
 * word earns gentler, cheaper recovery — the goodwill the big PSPs can't model
 * because they never ask).
 *
 * All timestamps are ISO-UTC strings derived from an explicit `nowMs` so the
 * loop is fully reproducible (no Date.now() in the data path).
 */
import type { Client } from "@libsql/client";
import { isoUtc } from "@arbiter/shared";

/** Default horizon offered when a customer promises to pay: 7 days. */
export const PROMISE_HORIZON_MS = 7 * 86_400_000;

export interface PromiseRecord {
  id: string;
  tenantId: string;
  customerId: string;
  proposalId: string;
  eventId: string;
  amountPaise: number;
  promisedAtUtc: string;
  createdAtUtc: string;
}

/**
 * Record a promise-to-pay row for a chosen PROMISE_TO_PAY proposal.
 * `promisedAtUtc` defaults to nowMs + PROMISE_HORIZON_MS (deterministic).
 */
export async function recordPromiseToPay(
  client: Client,
  args: {
    tenantId: string;
    customerId: string;
    proposalId: string;
    eventId: string;
    amountPaise: number;
    nowMs: number;
    promisedAtUtc?: string;
  },
): Promise<PromiseRecord> {
  const id = `promise_${args.proposalId}`;
  const createdAtUtc = isoUtc(args.nowMs);
  const promisedAtUtc = args.promisedAtUtc ?? isoUtc(args.nowMs + PROMISE_HORIZON_MS);
  await client.execute({
    sql: `INSERT INTO promise_to_pay
            (id, tenant_id, customer_id, proposal_id, event_id, amount_paise,
             promised_at_utc, status, resolved_at_utc, created_at_utc)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, ?)`,
    args: [
      id,
      args.tenantId,
      args.customerId,
      args.proposalId,
      args.eventId,
      args.amountPaise,
      promisedAtUtc,
      createdAtUtc,
    ],
  });
  return {
    id,
    tenantId: args.tenantId,
    customerId: args.customerId,
    proposalId: args.proposalId,
    eventId: args.eventId,
    amountPaise: args.amountPaise,
    promisedAtUtc,
    createdAtUtc,
  };
}

/**
 * Fraction of resolved promises this customer KEPT (kept / (kept + broken)).
 * Returns 0 when there are no resolved promises (fail-closed signal).
 */
export async function queryPromiseKeptRate(
  client: Client,
  customerId: string,
): Promise<number> {
  const res = await client.execute({
    sql: `SELECT status, COUNT(*) AS n FROM promise_to_pay
          WHERE customer_id = ? GROUP BY status`,
    args: [customerId],
  });
  let kept = 0;
  let broken = 0;
  for (const row of res.rows) {
    const r = row as unknown as { status: string; n: number };
    if (r.status === "KEPT") kept = Number(r.n);
    else if (r.status === "BROKEN") broken = Number(r.n);
  }
  const resolved = kept + broken;
  return resolved === 0 ? 0 : kept / resolved;
}

/**
 * Reconcile overdue PENDING promises: any promise whose `promised_at_utc` has
 * passed without a KEPT resolution is marked BROKEN. Returns the number closed.
 * (A real deployment would only mark BROKEN after confirming no successful debit
 * arrived; for the demo we treat an unmet deadline as broken — conservative.)
 */
export async function reconcilePromises(client: Client, nowMs: number): Promise<number> {
  const nowIso = isoUtc(nowMs);
  const res = await client.execute({
    sql: `UPDATE promise_to_pay
          SET status = 'BROKEN', resolved_at_utc = ?
          WHERE status = 'PENDING' AND promised_at_utc <= ?`,
    args: [nowIso, nowIso],
  });
  return res.rowsAffected ?? 0;
}

/** Mark a specific promise KEPT (called when a later successful debit is observed). */
export async function markPromiseKept(
  client: Client,
  proposalId: string,
  nowMs: number,
): Promise<void> {
  await client.execute({
    sql: `UPDATE promise_to_pay
          SET status = 'KEPT', resolved_at_utc = ?
          WHERE proposal_id = ? AND status = 'PENDING'`,
    args: [isoUtc(nowMs), proposalId],
  });
}
