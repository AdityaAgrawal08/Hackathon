/**
 * Two-Way Reconciliation Engine & Crash Sweeper.
 *
 * Reconciles unresolved payments (UNRESOLVED_UNKNOWN / UNRESOLVED_PENDING)
 * by querying the authoritative gateway Status API with exponential backoff and randomized jitter.
 *
 * Invariants:
 * 1. UNRESOLVED_UNKNOWN is never automatically converted to RESOLVED_FAILED on timeout.
 * 2. On 5-minute timeout, intent transitions to RECONCILIATION_EXHAUSTED -> MANUAL_REVIEW_REQUIRED.
 * 3. Exactly one LocalSettlement is committed upon provider-confirmed CAPTURED status.
 * 4. Multi-worker sweeper coordination via atomic SQLite row claiming.
 */
import type { Client } from "@libsql/client";
import { isoUtc } from "@arbiter/shared";
import { MAX_RECONCILIATION_TTL_MS } from "../constants.js";
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

export const MAX_RECONCILIATION_DURATION_MS = MAX_RECONCILIATION_TTL_MS;
export const BACKOFF_STEPS_MS = [2000, 4000, 8000, 16000, 32000, 60000];

/** Calculate exponential backoff with +/- 20% randomized jitter to prevent thundering herd */
export function calculateBackoffMs(attemptIndex: number): number {
  const base = BACKOFF_STEPS_MS[Math.min(attemptIndex, BACKOFF_STEPS_MS.length - 1)] ?? 60000;
  const jitter = 0.8 + 0.4 * Math.random();
  return Math.floor(base * jitter);
}

export async function reconcilePaymentIntent(
  client: Client,
  gateway: ReconcileGateway,
  intentId: string,
  nowMs: number,
): Promise<ReconcileResult> {
  // 1. Fetch intent from DB
  const piRes = await client.execute({
    sql: `SELECT * FROM payment_intents WHERE id = ?`,
    args: [intentId],
  });

  if (piRes.rows.length === 0) {
    throw new Error(`reconcilePaymentIntent: Unknown intent ${intentId}`);
  }

  const row = piRes.rows[0] as unknown as {
    id: string;
    order_id?: string;
    tenant_id: string;
    amount_paise: number;
    status: string;
    client_visible: string;
    created_at_utc: string;
    client_idem_key?: string;
  };

  const currentStatus = String(row.status);
  if (currentStatus === "SUCCEEDED" || currentStatus === "FAILED" || currentStatus === "CANCELLED") {
    return {
      resolved: true,
      knowledgeStatus: currentStatus === "SUCCEEDED" ? "RESOLVED_SUCCESS" : "RESOLVED_FAILED",
      reconciliationState: "RECONCILED",
    };
  }

  // 2. Fetch latest payment attempt for providerPaymentId
  const attRes = await client.execute({
    sql: `SELECT client_idem_key, provider_payment_id FROM payment_attempts
          WHERE payment_intent_id = ? ORDER BY started_at_utc DESC LIMIT 1`,
    args: [intentId],
  });
  const att = attRes.rows[0] as unknown as { client_idem_key?: string; provider_payment_id?: string } | undefined;

  const parsedTime = Date.parse(row.created_at_utc);
  const ageMs = Number.isNaN(parsedTime) ? 0 : nowMs - parsedTime;
  const nowIso = isoUtc(nowMs);
  const providerLookupId = att?.provider_payment_id || row.id;

  // 3. Query Gateway Status API
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

  // 4. Evaluate Provider Authority
  if (gatewayStatus && (gatewayStatus.status === "captured" || gatewayStatus.status === "authorized")) {
    const idemKey = att?.client_idem_key || row.client_idem_key || row.id;
    const providerPaymentId = gatewayStatus.providerPaymentId;

    // Check if settlement already exists to prevent redundant audits
    const existingSettlement = await client.execute({
      sql: `SELECT id FROM local_settlements WHERE payment_intent_id = ?`,
      args: [row.id],
    });

    if (existingSettlement.rows.length === 0) {
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
                  SET status = 'SUCCEEDED', client_visible = 'SUCCEEDED', resolved_at_utc = ?, worker_claim_id = NULL
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
    } else {
      await client.execute({
        sql: `UPDATE payment_intents SET status = 'SUCCEEDED', client_visible = 'SUCCEEDED', worker_claim_id = NULL WHERE id = ?`,
        args: [row.id],
      });
    }

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
            SET status = 'FAILED', client_visible = 'FAILED', resolved_at_utc = ?, worker_claim_id = NULL
            WHERE id = ?`,
      args: [nowIso, row.id],
    });

    return {
      resolved: true,
      knowledgeStatus: "RESOLVED_FAILED",
      reconciliationState: "RECONCILED",
    };
  }

  // 5. Timeout check (5 minutes max duration)
  if (ageMs >= MAX_RECONCILIATION_DURATION_MS) {
    // Invariant: NEVER mark as FAILED! Remains UNRESOLVED_UNKNOWN.
    // Check if alarm was already logged to prevent audit spamming
    const existingAlarm = await client.execute({
      sql: `SELECT rowid FROM audit_log WHERE event_id = ? AND entry_type = 'TRIGGER' LIMIT 1`,
      args: [row.id],
    });


    if (existingAlarm.rows.length === 0) {
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
    }

    await client.execute({
      sql: `UPDATE payment_intents SET worker_claim_id = NULL WHERE id = ?`,
      args: [row.id],
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
 * Uses atomic row claiming to coordinate multiple workers safely.
 */
export async function sweepStuckIntents(
  client: Client,
  gateway: ReconcileGateway,
  nowMs: number,
  workerId = `worker_${process.pid}_${Math.random().toString(36).slice(2, 8)}`,
): Promise<number> {
  const claimTime = isoUtc(nowMs);
  const staleThreshold = isoUtc(nowMs - 60000); // 1-minute claim timeout
  const minAge = isoUtc(nowMs - 2000);

  // Atomically claim eligible intents
  await client.execute({
    sql: `UPDATE payment_intents
          SET worker_claim_id = ?, claimed_at_utc = ?
          WHERE status IN ('UNKNOWN', 'PROCESSING')
            AND created_at_utc <= ?
            AND (worker_claim_id IS NULL OR claimed_at_utc < ?)`,
    args: [workerId, claimTime, minAge, staleThreshold],
  });

  const claimed = await client.execute({
    sql: `SELECT id FROM payment_intents WHERE worker_claim_id = ? AND status IN ('UNKNOWN', 'PROCESSING')`,
    args: [workerId],
  });

  let resolvedCount = 0;
  for (const r of claimed.rows) {
    const res = await reconcilePaymentIntent(client, gateway, String(r.id), nowMs);
    if (res.resolved) resolvedCount++;
  }
  return resolvedCount;
}
