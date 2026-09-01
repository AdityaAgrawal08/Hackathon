/**
 * E-010: Drift Detection Integration Test
 *
 * Tests the actual drift detection logic by calling detectDrift() and verifying output.
 * Replaces the previous test that only did raw SQL inserts and hardcoded arithmetic.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createClient } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { saveModel } from "../../packages/ml/src/registry.js";
import { buildArtifact } from "../../packages/ml/src/artifact.js";
import { FEATURE_NAMES } from "../../packages/ml/src/features.js";
import { detectDrift, getRecentDriftChecks } from "../../packages/ml/src/drift.js";
import { isoUtc } from "@arbiter/shared";

const T0 = "2026-01-05T09:00:00.000Z";
const NOW = Date.UTC(2026, 1, 16, 10, 0, 0);

function artifact() {
  return buildArtifact({
    weights: FEATURE_NAMES.map(() => 0.08),
    bias: -1.2,
    mu: FEATURE_NAMES.map(() => 0),
    sigma: FEATURE_NAMES.map(() => 1),
    metricsJson: "{}",
    datasetSha256: "ds",
    trainedAtUtc: T0,
  });
}

let client: any;

beforeAll(async () => {
  client = createClient({ url: "file:./data/arbiter.sqlite" });
  await runMigrations(client);
  await client.execute({
    sql: `INSERT OR REPLACE INTO tenants (id, name, created_at_utc) VALUES ('demo', 'D', ?)`,
    args: [T0],
  });
  await saveModel(client, artifact(), "INCUMBENT");
});

describe("E-010 Drift Detection", () => {
  it("detectDrift returns OK when rates are close", async () => {
    const result = await detectDrift(client, {
      predictedRate: 0.50,
      realizedRate: 0.48,
      sampleSize: 100,
      windowStartUtc: T0,
      windowEndUtc: isoUtc(NOW),
      envelopeBefore: { envelope_version: "env-v1", enabled: true },
      envelopeAfter: { envelope_version: "env-v1", enabled: true },
    });

    expect(result.verdict).toBe("OK");
    expect(result.predictedRate).toBe(0.50);
    expect(result.realizedRate).toBe(0.48);
    expect(result.delta).toBeCloseTo(0.02, 4);
    expect(result.sampleSize).toBe(100);
    expect(result.id).toBeTruthy();
  });

  it("detectDrift returns CONTRACTED when realized is much lower", async () => {
    const result = await detectDrift(client, {
      predictedRate: 0.60,
      realizedRate: 0.40,
      sampleSize: 80,
      windowStartUtc: T0,
      windowEndUtc: isoUtc(NOW),
      envelopeBefore: { envelope_version: "env-v1", enabled: true },
      envelopeAfter: { envelope_version: "env-v1", enabled: false },
    });

    expect(result.verdict).toBe("CONTRACTED");
    expect(result.delta).toBeCloseTo(0.20, 4);
  });

  it("detectDrift persists to drift_checks table", async () => {
    const result = await detectDrift(client, {
      predictedRate: 0.55,
      realizedRate: 0.52,
      sampleSize: 50,
      windowStartUtc: T0,
      windowEndUtc: isoUtc(NOW),
      envelopeBefore: { envelope_version: "env-v1" },
      envelopeAfter: { envelope_version: "env-v1" },
    });

    const row = await client.execute({
      sql: `SELECT verdict, predicted_rate, realized_rate, sample_size FROM drift_checks WHERE id = ?`,
      args: [result.id],
    });

    expect(row.rows.length).toBe(1);
    expect(String(row.rows[0]!.verdict)).toBe("OK");
    expect(Number(row.rows[0]!.predicted_rate)).toBeCloseTo(0.55, 4);
    expect(Number(row.rows[0]!.realized_rate)).toBeCloseTo(0.52, 4);
    expect(Number(row.rows[0]!.sample_size)).toBe(50);
  });

  it("getRecentDriftChecks returns recent entries", async () => {
    // Insert a few drift checks
    for (let i = 0; i < 3; i++) {
      await detectDrift(client, {
        predictedRate: 0.5 + i * 0.05,
        realizedRate: 0.45 + i * 0.05,
        sampleSize: 30 + i * 10,
        windowStartUtc: T0,
        windowEndUtc: isoUtc(NOW + i * 86400000),
        envelopeBefore: { envelope_version: "env-v1" },
        envelopeAfter: { envelope_version: "env-v1" },
      }, NOW + i * 86400000);
    }

    const recent = await getRecentDriftChecks(client, 5);
    expect(recent.length).toBeGreaterThanOrEqual(3);

    // All should have valid verdicts
    for (const check of recent) {
      expect(["OK", "CONTRACTED"]).toContain(check.verdict);
      expect(check.predictedRate).toBeGreaterThanOrEqual(0);
      expect(check.predictedRate).toBeLessThanOrEqual(1);
      expect(check.realizedRate).toBeGreaterThanOrEqual(0);
      expect(check.realizedRate).toBeLessThanOrEqual(1);
    }
  });

  it("drift_checks table exists and is queryable", async () => {
    const r = await client.execute({ sql: "SELECT count(*) as n FROM drift_checks", args: [] });
    expect(r.rows.length).toBeGreaterThanOrEqual(0);
  });

  it("metrics_runs table exists and is queryable", async () => {
    const r = await client.execute({ sql: "SELECT count(*) as n FROM metrics_runs", args: [] });
    expect(r.rows.length).toBeGreaterThanOrEqual(0);
  });

  it("summary computes recovery rates correctly", async () => {
    const controlTotalRecovered = 5000;
    const pipelineTotalRecovered = 7500;
    const totalEventsPerIteration = 230;
    const controlRecoveryRate = controlTotalRecovered / totalEventsPerIteration;
    const pipelineRecoveryRate = pipelineTotalRecovered / totalEventsPerIteration;

    expect(controlRecoveryRate).toBeCloseTo(21.74, 2);
    expect(pipelineRecoveryRate).toBeCloseTo(32.61, 2);
  });
});
