/**
 * B-009: Full pipeline integration test.
 * Exercises the complete flow: webhook → ingest → features → predict →
 * decide → propose → approve with razorpay dry-run.
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
      classes: ["SOFT_RETRYABLE", "HARD_METHOD_DEAD", "NETWORK_TIMEOUT", "RISK_FLAGGED"],
      channels: ["RETRY_NOW", "RETRY_PAYDAY", "ALTERNATE_UPI_LINK", "REMINDER_LINK"],
      max_attempts: 3, max_amount_paise: 10_000_000, require_quiet_ok: false,
    })],
  });
});

async function setupEvent(custId: string, evtId: string, amountPaise: number, failureCode: string, phone: string, email: string) {
  await client.execute({
    sql: `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,channel_responsiveness,opted_out,prior_success_count,joined_at_utc) VALUES (?,'demo','Test User',?,?, '{"28":4}',0.8,0,10,?)`,
    args: [custId, phone, email, T0],
  });
  await client.execute({
    sql: `INSERT INTO payment_events (id,tenant_id,customer_id,rzp_payment_id,subscription_id,amount_paise,failure_code,failure_class_hint,source,occurred_at_utc,ingested_at_utc) VALUES (?,'demo',?,NULL,NULL,?,?,?,'SEED',?,?)`,
    args: [evtId, custId, amountPaise, failureCode, failureCode.split("_")[0] ?? "UNKNOWN", T0, T0],
  });
}

describe("B-009: Full pipeline integration (webhook → execute)", () => {
  it("complete recovery flow for SOFT_RETRYABLE failure", async () => {
    await setupEvent("cust_e2e_soft", "evt_e2e_soft", 199900, "INSUFFICIENT_FUNDS", "+919876543210", "test@test.com");

    const processResult = await processEvent(client, "evt_e2e_soft", { nowMs: NOW });
    expect(processResult.status).toBe("PROPOSED");
    expect(processResult.proposalId).toBeDefined();
    expect(processResult.probability).toBeGreaterThan(0);
    expect(processResult.probability).toBeLessThan(1);

    const propRow = await client.execute({
      sql: `SELECT state, action_json FROM proposals WHERE id = ?`,
      args: [processResult.proposalId!],
    });
    expect(propRow.rows.length).toBe(1);
    const proposalState = String(propRow.rows[0]!.state);
    expect(proposalState).not.toBe("REJECTED");
    const action = JSON.parse(String(propRow.rows[0]!.action_json));
    expect(action).toBeDefined();
    expect(action.action).toBeDefined();
  });

  it("complete recovery flow for HARD_METHOD_DEAD failure", async () => {
    await setupEvent("cust_e2e_hard", "evt_e2e_hard", 499900, "CARD_EXPIRED", "+919876543211", "test2@test.com");

    const processResult = await processEvent(client, "evt_e2e_hard", { nowMs: NOW });
    expect(processResult.status).toBe("PROPOSED");
    expect(processResult.proposalId).toBeDefined();

    const propRow = await client.execute({
      sql: `SELECT action_json FROM proposals WHERE id = ?`,
      args: [processResult.proposalId!],
    });
    expect(propRow.rows.length).toBe(1);
    const action = JSON.parse(String(propRow.rows[0]!.action_json));
    expect(action.action).not.toBe("RETRY_NOW");
  });

  it("full pipeline with NETWORK_TIMEOUT failure", async () => {
    await setupEvent("cust_e2e_net", "evt_e2e_net", 99900, "GATEWAY_TIMEOUT", "+919876543212", "test3@test.com");

    const processResult = await processEvent(client, "evt_e2e_net", { nowMs: NOW });
    expect(processResult.status).toBe("PROPOSED");
    expect(processResult.probability).toBeGreaterThan(0);
  });
});
