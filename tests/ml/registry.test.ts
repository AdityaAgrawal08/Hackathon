/**
 * P2 unit gates — immutable model registry + frozen feature store.
 *  - artifact round-trips through model_versions with shas intact
 *  - INCUMBENT is unique; promotion retires the predecessor (P8-B1 groundwork)
 *  - frozen feature rows refuse silent mutation (I-3/I-4)
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { saveModel, getIncumbent } from "../../packages/ml/src/registry.js";
import { saveFeatures, loadFeatureVectors } from "../../packages/ml/src/features_store.js";
import { buildArtifact } from "../../packages/ml/src/artifact.js";
import { FEATURE_NAMES } from "../../packages/ml/src/features.js";

let client: Client;

const ARTIFACT_A = () =>
  buildArtifact({
    weights: [0.1, 0.2],
    bias: 0.05,
    mu: [0, 0],
    sigma: [1, 1],
    metricsJson: JSON.stringify({ auc: 0.85 }),
    datasetSha256: "deadbeef",
    trainedAtUtc: "2026-08-25T00:00:00.000Z",
  });

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await runMigrations(client);
  // features.event_id has an FK into payment_events — seed a parent row.
  const NOW = "2026-08-25T00:00:00.000Z";
  await client.execute({
    sql: `INSERT INTO tenants (id,name,created_at_utc) VALUES ('demo','Demo Merchant',?)`,
    args: [NOW],
  });
  await client.execute({
    sql: `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,joined_at_utc)
          VALUES ('cust_t','demo','Test C','+919000000001','t@example.test',?)`,
    args: [NOW],
  });
  await client.execute({
    sql: `INSERT INTO payment_events (id,tenant_id,customer_id,amount_paise,failure_code,source,occurred_at_utc,ingested_at_utc)
          VALUES ('evt_store_1','demo','cust_t',49900,'INSUFFICIENT_FUNDS','TRAINING',?,?)`,
    args: [NOW, NOW],
  });
});

describe("model registry", () => {
  it("round-trips an artifact with provenance intact", async () => {
    const a = ARTIFACT_A();
    await saveModel(client, a, "INCUMBENT");
    const loaded = await getIncumbent(client);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(a.id);
    expect(loaded!.weightsSha256).toBe(a.weightsSha256);
    expect(loaded!.datasetSha256).toBe("deadbeef");
    expect(loaded!.weights).toEqual([0.1, 0.2]);
    expect(loaded!.featureNames).toEqual([...FEATURE_NAMES]);
  });

  it("keeps exactly one INCUMBENT — promotion retires the predecessor", async () => {
    const b = buildArtifact({
      weights: [0.9, 0.9],
      bias: 0.5,
      mu: [0, 0],
      sigma: [1, 1],
      metricsJson: "{}",
      datasetSha256: "cafe",
      trainedAtUtc: "2026-08-26T00:00:00.000Z",
    });
    await saveModel(client, b, "INCUMBENT");
    const incumbent = await getIncumbent(client);
    expect(incumbent!.id).toBe(b.id);

    const statuses = await client.execute(`SELECT id, status FROM model_versions`);
    const byId = new Map(statuses.rows.map((r) => [String(r.id), String(r.status)]));
    expect(byId.get(b.id)).toBe("INCUMBENT");
    expect(byId.get(ARTIFACT_A().id)).toBe("RETIRED");
    expect([...byId.values()].filter((s) => s === "INCUMBENT").length).toBe(1);
  });
});

describe("features store (frozen)", () => {
  it("saves once, reloads identically, no-ops on re-save", async () => {
    const rec = { eventId: "evt_store_1", values: [1, 2, 3] };
    const first = await saveFeatures(client, [rec], Date.parse("2026-08-25T00:00:00Z"));
    expect(first.inserted).toBe(1);

    const second = await saveFeatures(client, [rec], Date.parse("2026-08-25T01:00:00Z"));
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(1);

    const vecs = await loadFeatureVectors(client, ["evt_store_1"]);
    expect(vecs.get("evt_store_1")).toEqual([1, 2, 3]);
  });

  it("throws on vector drift for the same (event, version) — never mutates", async () => {
    await expect(
      saveFeatures(client, [{ eventId: "evt_store_1", values: [9, 9, 9] }], Date.now()),
    ).rejects.toThrow(/drift/);
    // frozen row untouched
    const vecs = await loadFeatureVectors(client, ["evt_store_1"]);
    expect(vecs.get("evt_store_1")).toEqual([1, 2, 3]);
  });

  it("missing vectors come back absent so callers can fail closed", async () => {
    const vecs = await loadFeatureVectors(client, ["never_computed"]);
    expect(vecs.has("never_computed")).toBe(false);
  });
});
