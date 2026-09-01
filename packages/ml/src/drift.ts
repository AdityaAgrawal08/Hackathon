/**
 * E-010: Drift Detection — compares predicted recovery rate against realized rate.
 *
 * Detects model drift by comparing the model's predicted probability distribution
 * against actual outcomes over a time window. If the realized rate is significantly
 * lower than predicted, the verdict is "CONTRACTED" (model is overconfident).
 */
import type { Client } from "@libsql/client";
import { isoUtc, hashSeed } from "@arbiter/shared";

export interface DriftCheckInput {
  /** Predicted recovery rate from model probabilities (mean of holdout scores). */
  predictedRate: number;
  /** Realized recovery rate from actual outcomes in the window. */
  realizedRate: number;
  /** Number of events in the window. */
  sampleSize: number;
  /** Start of the observation window. */
  windowStartUtc: string;
  /** End of the observation window. */
  windowEndUtc: string;
  /** Autonomy envelope before adjustment. */
  envelopeBefore: Record<string, unknown>;
  /** Autonomy envelope after adjustment (same if no drift). */
  envelopeAfter: Record<string, unknown>;
}

export interface DriftCheckResult {
  id: string;
  verdict: "OK" | "CONTRACTED";
  predictedRate: number;
  realizedRate: number;
  delta: number;
  sampleSize: number;
}

/**
 * Threshold: if realized rate is >10pp below predicted, verdict is CONTRACTED.
 * This is a simple drift detection heuristic — not a formal statistical test.
 */
const DRIFT_THRESHOLD_PP = 10;

/**
 * Detect drift between predicted and realized recovery rates.
 * Persists the check to drift_checks table.
 */
export async function detectDrift(
  client: Client,
  input: DriftCheckInput,
  nowMs: number = Date.now(),
): Promise<DriftCheckResult> {
  const delta = input.predictedRate - input.realizedRate;
  const deltaPp = delta * 100; // in percentage points
  const verdict: "OK" | "CONTRACTED" = deltaPp > DRIFT_THRESHOLD_PP ? "CONTRACTED" : "OK";

  const id = `drift_${hashSeed(input.windowStartUtc + input.windowEndUtc).toString(36)}`;

  // Persist to drift_checks table
  await client.execute({
    sql: `INSERT OR REPLACE INTO drift_checks
          (id, window_start_utc, window_end_utc, sample_size, predicted_rate, realized_rate, verdict, envelope_before_json, envelope_after_json, checked_at_utc)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      input.windowStartUtc,
      input.windowEndUtc,
      input.sampleSize,
      input.predictedRate,
      input.realizedRate,
      verdict,
      JSON.stringify(input.envelopeBefore),
      JSON.stringify(verdict === "CONTRACTED" ? input.envelopeAfter : input.envelopeBefore),
      isoUtc(nowMs),
    ],
  });

  return {
    id,
    verdict,
    predictedRate: input.predictedRate,
    realizedRate: input.realizedRate,
    delta,
    sampleSize: input.sampleSize,
  };
}

/**
 * Query recent drift checks from the database.
 */
export async function getRecentDriftChecks(
  client: Client,
  limit: number = 10,
): Promise<DriftCheckResult[]> {
  const rows = await client.execute({
    sql: `SELECT id, predicted_rate, realized_rate, verdict, sample_size FROM drift_checks ORDER BY checked_at_utc DESC LIMIT ?`,
    args: [limit],
  });

  return rows.rows.map((row) => ({
    id: String(row.id),
    verdict: String(row.verdict) as "OK" | "CONTRACTED",
    predictedRate: Number(row.predicted_rate),
    realizedRate: Number(row.realized_rate),
    delta: Number(row.predicted_rate) - Number(row.realized_rate),
    sampleSize: Number(row.sample_size),
  }));
}
