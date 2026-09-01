/**
 * B-008: Concurrent access tests.
 * Verifies that concurrent operations on shared customer/proposal records
 * produce consistent state — no double-debits, no lost proposals.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { processEvent } from "../../packages/ml/src/pipeline.js";
import { saveModel } from "../../packages/ml/src/registry.js";
import { buildArtifact } from "../../packages/ml/src/artifact.js";
import { FEATURE_NAMES } from "../../packages/ml/src/features.js";

let client: Client;
const NOW = Date.UTC(2026, 1, 15, 10, 0, 0);
const T0 = "2026-01-05T09:00:00.000Z";

function artifact() {
  return buildArtifact({
    weights: FEATURE_NAMES.map(() => 0.08),
    bias: -1.2,
    mu: FEATURE_NAMES.map(() => 0),
    sigma: FEATURE_NAMES.map(() => 1),
    metricsJson: "{}",
    datasetSha256: "testds",
    trainedAtUtc: T0,
  });
}

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await runMigrations(client);
  await saveModel(client, artifact(), "INCUMBENT");
  await client.execute({ sql: `INSERT INTO tenants (id,name,created_at_utc) VALUES ('demo','Demo',?)`, args: [T0] });
  await client.execute({
    sql: `UPDATE tenants SET autonomy_envelope_json = ? WHERE id = 'demo'`,
    args: [JSON.stringify({
      envelope_version: "env-v1", enabled: true,
      classes: ["SOFT_RETRYABLE", "HARD_METHOD_DEAD", "NETWORK_TIMEOUT"],
      channels: ["RETRY_NOW", "RETRY_PAYDAY", "ALTERNATE_UPI_LINK"],
      max_attempts: 3, max_amount_paise: 10_000_000, require_quiet_ok: false,
    })],
  });
});

async function createCustomer(custId: string) {
  await client.execute({
    sql: `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,channel_responsiveness,opted_out,prior_success_count,joined_at_utc) VALUES (?,'demo','X','+919000000000','x@test.com','{}',0.7,0,5,?)`,
    args: [custId, T0],
  });
}

async function createEvent(evtId: string, custId: string) {
  await client.execute({
    sql: `INSERT INTO payment_events (id,tenant_id,customer_id,rzp_payment_id,subscription_id,amount_paise,failure_code,failure_class_hint,source,occurred_at_utc,ingested_at_utc) VALUES (?,'demo',?,NULL,NULL,10000,'INSUFFICIENT_FUNDS','SEED','SEED',?,?)`,
    args: [evtId, custId, T0, T0],
  });
}

describe("B-008: Concurrent access safety", () => {
  it("concurrent processEvent on same customer skips duplicates", async () => {
    const custId = "cust_concurrent_1";
    await createCustomer(custId);

    const eventIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const evtId = `evt_concurrent_${i}`;
      eventIds.push(evtId);
      await createEvent(evtId, custId);
    }

    const results = await Promise.all(
      eventIds.map((id) => processEvent(client, id, { nowMs: NOW })),
    );

    const proposed = results.filter((r) => r.status === "PROPOSED");
    const skipped = results.filter((r) => r.status === "SKIPPED_OPEN_PROPOSAL");
    expect(proposed.length).toBeLessThanOrEqual(1);
    expect(skipped.length).toBeGreaterThanOrEqual(4);
  });

  it("concurrent processEvent on different customers all succeed", async () => {
    const events: string[] = [];
    for (let i = 0; i < 5; i++) {
      const custId = `cust_parallel_${i}`;
      const evtId = `evt_parallel_${i}`;
      await createCustomer(custId);
      await createEvent(evtId, custId);
      events.push(evtId);
    }

    const results = await Promise.all(
      events.map((id) => processEvent(client, id, { nowMs: NOW })),
    );
    const proposed = results.filter((r) => r.status === "PROPOSED");
    expect(proposed.length).toBe(5);
  });

  it("no double-counting in proposal table under concurrent access", async () => {
    const custId = "cust_double_count";
    await createCustomer(custId);

    const evtId = "evt_double_count";
    await createEvent(evtId, custId);

    const results = await Promise.all([
      processEvent(client, evtId, { nowMs: NOW }),
      processEvent(client, evtId, { nowMs: NOW }),
      processEvent(client, evtId, { nowMs: NOW }),
    ]);

    const proposed = results.filter((r) => r.status === "PROPOSED");
    expect(proposed.length).toBe(1);

    const propCount = await client.execute({
      sql: `SELECT COUNT(*) as cnt FROM proposals WHERE event_id = ?`,
      args: [evtId],
    });
    expect(Number(propCount.rows[0]!.cnt)).toBe(1);
  });
});
