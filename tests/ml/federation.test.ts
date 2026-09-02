import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import {
  federatedAverage,
  simulateFederatedTraining,
  promoteFederatedModel,
  FEDERATION_EPOCH_MS,
  type SiloReport,
} from "../../packages/ml/src/federation.js";
import { FEATURE_COUNT } from "../../packages/ml/src/features.js";

describe("Federated merchant intelligence (§4.2)", () => {
  function makeSilo(id: string, weights: number[], bias = 0, samples = 100): SiloReport {
    return {
      siloId: id,
      weights: weights.length === FEATURE_COUNT ? weights : Array(FEATURE_COUNT).fill(0).map((_, i) => weights[i % weights.length] ?? 0),
      bias,
      sampleCount: samples,
      trainedAtUtc: "2026-01-01T00:00:00.000Z",
    };
  }

  it("federatedAverage: equal-weight silos → mean weights", () => {
    const silos: SiloReport[] = [
      makeSilo("a", [1, 2, 3], 0, 100),
      makeSilo("b", [3, 2, 1], 0, 100),
    ];
    const { weights, bias } = federatedAverage(silos);
    expect(weights[0]).toBeCloseTo(2, 5);
    expect(weights[1]).toBeCloseTo(2, 5);
    expect(weights[2]).toBeCloseTo(2, 5);
    expect(bias).toBe(0);
  });

  it("federatedAverage: weighted by sampleCount", () => {
    const silos: SiloReport[] = [
      makeSilo("a", [0, 0, 0], 0, 1000),
      makeSilo("b", [10, 10, 10], 0, 100),
    ];
    const { weights } = federatedAverage(silos);
    // 1000*0 + 100*10 / 1100 ≈ 0.909
    expect(weights[0]).toBeCloseTo(10 / 11, 2);
    expect(weights[1]).toBeCloseTo(10 / 11, 2);
  });

  it("federatedAverage: DP noise scale > 0 adds variance", () => {
    const base = makeSilo("base", [0, 0], 0, 100);
    const { weights: w1 } = federatedAverage([base, base], 0);
    const { weights: w2 } = federatedAverage([base, base], 0.1);
    expect(w1[0]).toBe(0);
    expect(w1[1]).toBe(0);
    expect(w2[0] === 0 && w2[1] === 0).toBe(false);
  });

  it("federatedAverage: rejects dimension mismatch", () => {
    expect(() => federatedAverage([
      { siloId: "a", weights: [1, 2], bias: 0, sampleCount: 10, trainedAtUtc: "2026-01-01T00:00:00.000Z" },
      { siloId: "b", weights: [1, 2, 3], bias: 0, sampleCount: 10, trainedAtUtc: "2026-01-01T00:00:00.000Z" },
    ])).toThrow(/dim/);
  });

  it("simulateFederatedTraining: produces valid artifact with correct dimensions", async () => {
    const art = await simulateFederatedTraining(4, 0.01);
    expect(art.weights.length).toBe(FEATURE_COUNT);
    expect(art.kind).toBe("logreg");
    expect(art.id).toContain("federated@");
    expect(art.featureVersion).toBe("feat-v1");
    expect(art.trainedAtUtc).toBeDefined();
    const metrics = JSON.parse(art.metricsJson);
    expect(metrics.siloCount).toBe(4);
    expect(metrics.dpNoiseScale).toBe(0.01);
    expect(metrics.globalSampleCount).toBeGreaterThan(0);
  });

  it("bug #11/#41: simulateFederatedTraining is byte-reproducible (deterministic clock + per-silo offset)", async () => {
    const a = await simulateFederatedTraining(4, 0.01);
    const b = await simulateFederatedTraining(4, 0.01);
    expect(a.id).toBe(b.id);
    expect(a.weights).toEqual(b.weights);
    expect(a.bias).toBe(b.bias);
    expect(a.trainedAtUtc).toBe(b.trainedAtUtc);
    // fixed-epoch clock, not the wall clock
    expect(a.trainedAtUtc).toBe(new Date(FEDERATION_EPOCH_MS).toISOString());
  });

  it("bug #10: federatedAverage DP noise is deterministic for identical inputs (no Math.random)", () => {
    const zeros = () => Array(FEATURE_COUNT).fill(0);
    const silos: SiloReport[] = [
      { siloId: "a", weights: zeros(), bias: 0, sampleCount: 100, trainedAtUtc: "2026-01-01T00:00:00.000Z" },
      { siloId: "b", weights: zeros(), bias: 0, sampleCount: 100, trainedAtUtc: "2026-01-01T00:00:00.000Z" },
    ];
    const r1 = federatedAverage(silos, 0.1);
    const r2 = federatedAverage(silos, 0.1);
    expect(r1.weights).toEqual(r2.weights); // identical inputs → identical noise
    expect(r1.weights[0]).not.toBe(0); // noise was actually applied
  });
});

describe("Federated promotion → registry + audit (§4.2)", () => {
  let client: Client;
  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await runMigrations(client);
  });

  it("promoteFederatedModel makes the global model INCUMBENT and writes an audit trail", async () => {
    const art = await simulateFederatedTraining(4, 0.01);
    await promoteFederatedModel(client, art);

    const inc = await client.execute(`SELECT id, status FROM model_versions WHERE id = ?`, [art.id]);
    expect(String(inc.rows[0]!.status)).toBe("INCUMBENT");

    const audit = await client.execute(
      `SELECT entry_type, payload_json FROM audit_log WHERE entry_type = 'OUTCOME' AND payload_json LIKE '%federated%'`,
    );
    expect(audit.rows.length).toBe(1);
    const payload = JSON.parse(String(audit.rows[0]!.payload_json)) as {
      promotedModelId: string;
      siloCount: number;
      dpNoiseScale: number;
      aggregationHash: string;
    };
    expect(payload.promotedModelId).toBe(art.id);
    expect(payload.siloCount).toBe(4);
    expect(payload.dpNoiseScale).toBe(0.01);
    expect(payload.aggregationHash).toMatch(/^[0-9a-f]+$/);
  });
});