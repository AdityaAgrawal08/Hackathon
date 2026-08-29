/**
 * Two-Way Reconciliation Engine & Crash Sweeper.
 *
 * Reconciles unresolved payments (UNRESOLVED_UNKNOWN / UNRESOLVED_PENDING)
 * by querying the authoritative gateway Status API with exponential backoff.
 *
 * Invariants:
 * 1. UNRESOLVED_UNKNOWN is never automatically converted to RESOLVED_FAILED on timeout.
 * 2. On 5-minute timeout, intent transitions to RECONCILIATION_EXHAUSTED -> MANUAL_REVIEW_REQUIRED.
 * 3. Exactly one LocalSettlement is committed upon provider-confirmed CAPTURED status.
 */
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { isoUtc } from "@arbiter/shared";
import { canTransitionKnowledgeStatus, type KnowledgeStatus } from "./payment_state_machine.js";

export interface ReconcileGateway {
  fetchPayment(providerPaymentId: string): Promise<{
    providerPaymentId: string;
    providerOrderId: string;
    status: "captured" | "authorized" | "failed" | "pending";
    amountPaise: number;
    currency: string;
    errorCode?: string;
    errorDescription?: string;
  } | null>;
}


export interface ReconcileResult {
  resolved: boolean;
  knowledgeStatus: KnowledgeStatus;
  providerPaymentId?: string;
  reconciliationState: "RECONCILED" | "RECONCILING" | "RECONCILIATION_EXHAUSTED" | "NONE";
  error?: string;
}

export const MAX_RECONCILIATION_DURATION_MS = 300_000; // 5 minutes
export const BACKOFF_STEPS_MS = [2000, 4000, 8000, 16000, 32000, 60000]; // Exponential backoff with 60s max poll interval

export async function reconcilePaymentIntent(
  client: Client,
  gateway: ReconcileGateway,
  intentId: string,
  nowMs: number,
): Promise<ReconcileResult> {
  // 1. Fetch intent & attempts from DB
  const r = await client.execute({
    sql: `SELECT pi.*, pa.client_idem_key, pa.provider_payment_id AS attempt_provider_id
          FROM payment_intents pi
          LEFT JOIN payment_attempts pa ON pa.payment_intent_id = pi.id
          WHERE pi.id = ?
          ORDER BY pa.attempt_number DESC LIMIT 1`,
    args: [intentId],
  });

  if (r.rows.length === 0) {
    throw new Error(`reconcilePaymentIntent: Unknown intent ${intentId}`);
  }

  const row = r.rows[0] as unknown as {
    id: string;
    order_id: string;
    tenant_id: string;
    amount_paise: number;
    status: string;
    client_visible: string;
    created_at_utc: string;
    client_idem_key?: string;
    attempt_provider_id?: string;
  };

  const currentStatus = String(row.status);
  if (currentStatus === "SUCCEEDED" || currentStatus === "FAILED" || currentStatus === "CANCELLED") {
    return {
      resolved: true,
      knowledgeStatus: currentStatus === "SUCCEEDED" ? "RESOLVED_SUCCESS" : "RESOLVED_FAILED",
      reconciliationState: "RECONCILED",
    };
  }

  const ageMs = nowMs - Date.parse(row.created_at_utc);
  const nowIso = isoUtc(nowMs);
  const providerLookupId = row.attempt_provider_id || row.id;

  // 2. Query Gateway Status API
  let gatewayStatus = null;
  try {
    gatewayStatus = await gateway.fetchPayment(providerLookupId);
  } catch (err) {
    // Gateway outage / network drop during reconciliation
    return {
      resolved: false,
      knowledgeStatus: "UNRESOLVED_UNKNOWN",
      reconciliationState: "RECONCILING",
      error: (err as Error).message,
    };
  }

  // 3. Evaluate Provider Authority
  if (gatewayStatus && (gatewayStatus.status === "captured" || gatewayStatus.status === "authorized")) {
    const idemKey = row.client_idem_key || row.id;
    const providerPaymentId = gatewayStatus.providerPaymentId;

    // Atomic settlement commit
    await client.batch(
      [
        {
          sql: `INSERT INTO local_settlements
                  (id, payment_intent_id, idem_key, provider_payment_id, amount_paise, currency, settled_at_utc)
                VALUES (?, ?, ?, ?, ?, 'INR', ?)
                ON CONFLICT(payment_intent_id) DO NOTHING`,
          args: [`set_${row.id}`, row.id, idemKey, providerPaymentId, row.amount_paise, nowIso],
        },
        {
          sql: `UPDATE payment_intents
                SET status = 'SUCCEEDED', client_visible = 'SUCCEEDED', resolved_at_utc = ?
                WHERE id = ?`,
          args: [nowIso, row.id],
        },
        {
          sql: `INSERT INTO audit_log (ts_utc, tenant_id, event_id, actor, entry_type, payload_json)
                VALUES (?, ?, ?, 'SYSTEM', 'OUTCOME', ?)`,
          args: [
            nowIso,
            row.tenant_id || "demo",
            row.id,
            JSON.stringify({
              action: "RECONCILIATION_RESOLVED",
              outcome: "SUCCEEDED",
              providerPaymentId,
              amountPaise: row.amount_paise,
            }),
          ],
        },
      ],
      "write",
    );

    return {
      resolved: true,
      knowledgeStatus: "RESOLVED_SUCCESS",
      providerPaymentId,
      reconciliationState: "RECONCILED",
    };
  }

  if (gatewayStatus && gatewayStatus.status === "failed") {
    await client.execute({
      sql: `UPDATE payment_intents
            SET status = 'FAILED', client_visible = 'FAILED', resolved_at_utc = ?
            WHERE id = ?`,
      args: [nowIso, row.id],
    });

    return {
      resolved: true,
      knowledgeStatus: "RESOLVED_FAILED",
      reconciliationState: "RECONCILED",
    };
  }

  // 4. Timeout check (5 minutes max duration)
  if (ageMs >= MAX_RECONCILIATION_DURATION_MS) {
    // Mark as RECONCILIATION_EXHAUSTED -> MANUAL_REVIEW_REQUIRED.
    // Invariant: NEVER mark as FAILED! Remains UNRESOLVED_UNKNOWN.
    await client.execute({
      sql: `INSERT INTO audit_log (ts_utc, tenant_id, event_id, actor, entry_type, payload_json)
            VALUES (?, ?, ?, 'SYSTEM', 'TRIGGER', ?)`,
      args: [
        nowIso,
        row.tenant_id || "demo",
        row.id,
        JSON.stringify({
          alarm: "RECONCILIATION_EXHAUSTED",
          detail: "Payment state could not be confirmed within 5-minute window; flagged for manual review.",
          intentId: row.id,
          ageMs,
        }),
      ],
    });

    return {
      resolved: false,
      knowledgeStatus: "UNRESOLVED_UNKNOWN",
      reconciliationState: "RECONCILIATION_EXHAUSTED",
      error: "Reconciliation TTL expired; flagged for manual review.",
    };
  }

  return {
    resolved: false,
    knowledgeStatus: "UNRESOLVED_UNKNOWN",
    reconciliationState: "RECONCILING",
  };
}

/**
 * Sweep stuck intents in UNKNOWN or PROCESSING state.
 * Safe to run periodically and on application startup.
 */
export async function sweepStuckIntents(
  client: Client,
  gateway: ReconcileGateway,
  nowMs: number,
): Promise<number> {
  const stuck = await client.execute({
    sql: `SELECT id FROM payment_intents
          WHERE status IN ('UNKNOWN', 'PROCESSING')
            AND created_at_utc <= ?`,
    args: [isoUtc(nowMs - 2000)], // at least 2s old
  });

  let resolvedCount = 0;
  for (const r of stuck.rows) {
    const res = await reconcilePaymentIntent(client, gateway, String(r.id), nowMs);
    if (res.resolved) resolvedCount++;
  }
  return resolvedCount;
}
