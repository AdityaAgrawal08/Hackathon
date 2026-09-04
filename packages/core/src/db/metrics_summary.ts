import type { Client } from "@libsql/client";
import { logger } from "@arbiter/shared";

export interface VendorMetricsSummary {
  totalEvents: number;
  totalSuccesses: number;
  totalFailures: number;
  recoveredPaise: number;
  atRiskPaise: number;
  methodCard: number;
  methodUpi: number;
  methodNetbanking: number;
  methodWallet: number;
  methodOther: number;
  successRate: string;
  updatedAtUtc?: string;
}

export interface MetricsDelta {
  totalEvents?: number;
  totalSuccesses?: number;
  totalFailures?: number;
  recoveredPaise?: number;
  atRiskPaise?: number;
  methodCard?: number;
  methodUpi?: number;
  methodNetbanking?: number;
  methodWallet?: number;
  methodOther?: number;
}

/**
 * Returns a partial delta object for the given payment method.
 */
export function getMethodDelta(method?: string | null, increment: number = 1): Partial<MetricsDelta> {
  const m = (method || "").toLowerCase().trim();
  if (m === "card") return { methodCard: increment };
  if (m === "upi") return { methodUpi: increment };
  if (m === "netbanking") return { methodNetbanking: increment };
  if (m === "wallet") return { methodWallet: increment };
  return { methodOther: increment };
}

/**
 * Ensures a vendor metrics summary row exists with default 0s.
 */
export async function ensureVendorMetricsSummary(
  client: Client,
  vendorId: string = "global",
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await client.execute({
      sql: `INSERT INTO vendor_metrics_summary (
              id, total_events, total_successes, total_failures,
              recovered_paise, at_risk_paise, method_card, method_upi,
              method_netbanking, method_wallet, method_other, updated_at_utc
            ) VALUES (?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?)
            ON CONFLICT(id) DO NOTHING`,
      args: [vendorId, now],
    });
  } catch (err) {
    // If table doesn't exist in minimal test environments, fail gracefully
    logger.debug({ msg: "ensureVendorMetricsSummary skipped or failed", err });
  }
}

/**
 * Atomically updates running metrics counters by delta.
 */
export async function recordMetricsDelta(
  client: Client,
  delta: MetricsDelta,
  vendorId: string = "global",
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await ensureVendorMetricsSummary(client, vendorId);
    await client.execute({
      sql: `UPDATE vendor_metrics_summary SET
              total_events = total_events + ?,
              total_successes = total_successes + ?,
              total_failures = total_failures + ?,
              recovered_paise = recovered_paise + ?,
              at_risk_paise = at_risk_paise + ?,
              method_card = method_card + ?,
              method_upi = method_upi + ?,
              method_netbanking = method_netbanking + ?,
              method_wallet = method_wallet + ?,
              method_other = method_other + ?,
              updated_at_utc = ?
            WHERE id = ?`,
      args: [
        delta.totalEvents || 0,
        delta.totalSuccesses || 0,
        delta.totalFailures || 0,
        delta.recoveredPaise || 0,
        delta.atRiskPaise || 0,
        delta.methodCard || 0,
        delta.methodUpi || 0,
        delta.methodNetbanking || 0,
        delta.methodWallet || 0,
        delta.methodOther || 0,
        now,
        vendorId,
      ],
    });
  } catch (err) {
    // Gracefully handle environments without vendor_metrics_summary table
    logger.debug({ msg: "recordMetricsDelta skipped or failed", err });
  }
}

/**
 * Recomputes running metrics from live_payment_events in one pass and upserts into vendor_metrics_summary.
 */
export async function recomputeVendorMetricsSummary(
  client: Client,
  vendorId: string = "global",
): Promise<VendorMetricsSummary> {
  const now = new Date().toISOString();
  try {
    const stats = await client.execute({
      sql: `SELECT
              COUNT(*) as total_events,
              SUM(CASE WHEN status = 'captured' THEN 1 ELSE 0 END) as total_successes,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as total_failures,
              SUM(CASE WHEN status = 'captured' THEN amount_paise ELSE 0 END) as recovered_paise,
              SUM(CASE WHEN status = 'failed' THEN amount_paise ELSE 0 END) as at_risk_paise,
              SUM(CASE WHEN payment_method = 'card' THEN 1 ELSE 0 END) as method_card,
              SUM(CASE WHEN payment_method = 'upi' THEN 1 ELSE 0 END) as method_upi,
              SUM(CASE WHEN payment_method = 'netbanking' THEN 1 ELSE 0 END) as method_netbanking,
              SUM(CASE WHEN payment_method = 'wallet' THEN 1 ELSE 0 END) as method_wallet,
              SUM(CASE WHEN payment_method IS NULL OR payment_method = '' THEN 1 ELSE 0 END) as method_other
            FROM live_payment_events`,
      args: [],
    });

    const row = stats.rows[0] as any;
    const totalEvents = Number(row?.total_events || 0);
    const totalSuccesses = Number(row?.total_successes || 0);
    const totalFailures = Number(row?.total_failures || 0);
    const recoveredPaise = Number(row?.recovered_paise || 0);
    const atRiskPaise = Number(row?.at_risk_paise || 0);
    const methodCard = Number(row?.method_card || 0);
    const methodUpi = Number(row?.method_upi || 0);
    const methodNetbanking = Number(row?.method_netbanking || 0);
    const methodWallet = Number(row?.method_wallet || 0);
    const methodOther = Number(row?.method_other || 0);

    const summary: VendorMetricsSummary = {
      totalEvents,
      totalSuccesses,
      totalFailures,
      recoveredPaise,
      atRiskPaise,
      methodCard,
      methodUpi,
      methodNetbanking,
      methodWallet,
      methodOther,
      successRate: totalEvents > 0
        ? ((totalSuccesses / totalEvents) * 100).toFixed(1) + "%"
        : "0.0%",
      updatedAtUtc: now,
    };

    try {
      await client.execute({
        sql: `INSERT INTO vendor_metrics_summary (
                id, total_events, total_successes, total_failures,
                recovered_paise, at_risk_paise, method_card, method_upi,
                method_netbanking, method_wallet, method_other, updated_at_utc
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                total_events = excluded.total_events,
                total_successes = excluded.total_successes,
                total_failures = excluded.total_failures,
                recovered_paise = excluded.recovered_paise,
                at_risk_paise = excluded.at_risk_paise,
                method_card = excluded.method_card,
                method_upi = excluded.method_upi,
                method_netbanking = excluded.method_netbanking,
                method_wallet = excluded.method_wallet,
                method_other = excluded.method_other,
                updated_at_utc = excluded.updated_at_utc`,
        args: [
          vendorId,
          totalEvents,
          totalSuccesses,
          totalFailures,
          recoveredPaise,
          atRiskPaise,
          methodCard,
          methodUpi,
          methodNetbanking,
          methodWallet,
          methodOther,
          now,
        ],
      });
    } catch {
      // If table doesn't exist, ignore upsert
    }

    return summary;
  } catch (err) {
    logger.warn({ msg: "Failed to recompute vendor metrics", err });
    return {
      totalEvents: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      recoveredPaise: 0,
      atRiskPaise: 0,
      methodCard: 0,
      methodUpi: 0,
      methodNetbanking: 0,
      methodWallet: 0,
      methodOther: 0,
      successRate: "0.0%",
    };
  }
}

/**
 * Returns the vendor metrics summary in O(1) from vendor_metrics_summary.
 * If the row does not exist, recomputes once from live_payment_events.
 */
export async function getVendorMetricsSummary(
  client: Client,
  vendorId: string = "global",
): Promise<VendorMetricsSummary> {
  try {
    const res = await client.execute({
      sql: "SELECT * FROM vendor_metrics_summary WHERE id = ? LIMIT 1",
      args: [vendorId],
    });

    if (res.rows.length === 0) {
      return await recomputeVendorMetricsSummary(client, vendorId);
    }

    const row = res.rows[0] as any;
    const totalEvents = Number(row.total_events || 0);
    const totalSuccesses = Number(row.total_successes || 0);

    return {
      totalEvents,
      totalSuccesses,
      totalFailures: Number(row.total_failures || 0),
      recoveredPaise: Number(row.recovered_paise || 0),
      atRiskPaise: Number(row.at_risk_paise || 0),
      methodCard: Number(row.method_card || 0),
      methodUpi: Number(row.method_upi || 0),
      methodNetbanking: Number(row.method_netbanking || 0),
      methodWallet: Number(row.method_wallet || 0),
      methodOther: Number(row.method_other || 0),
      successRate: totalEvents > 0
        ? ((totalSuccesses / totalEvents) * 100).toFixed(1) + "%"
        : "0.0%",
      updatedAtUtc: String(row.updated_at_utc || ""),
    };
  } catch {
    // Fallback if table does not exist
    return await recomputeVendorMetricsSummary(client, vendorId);
  }
}
