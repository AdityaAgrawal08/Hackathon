/**
 * F-002: Reconciliation Worker Correctness
 *
 * Verifies that reconciliation correctly resolves stuck proposals:
 *  - Stale EXECUTING / UNKNOWN intents are claimed and reconciled
 *  - No Math.random() in production (backoff uses hashSeed)
 *  - Gateway returning captured → SUCCEEDED, failed → FAILED, pending → stays UNKNOWN
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { saveModel } from "../../packages/ml/src/registry.js";
import { buildArtifact } from "../../packages/ml/src/artifact.js";
import { FEATURE_NAMES } from "../../packages/ml/src/features.js";
import {
  reconcilePaymentIntent,
  sweepStuckIntents,
  calculateBackoffMs,
  type ReconcileGateway,
} from "../../packages/core/src/executor/reconciliation.js";
import { isoUtc } from "@arbiter/shared";
import { readFileSync } from "node:fs";

const T0 = "2026-01-05T09:00:00.000Z";
const NOW = Date.UTC(2026, 1, 15, 10, 0, 0);

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

let client: Client;
let modelId: string;

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await runMigrations(client);
  const art = artifact();
  modelId = art.id;
  await saveModel(client, art, "INCUMBENT");
  await client.execute({ sql: `INSERT INTO tenants (id,name,created_at_utc) VALUES ('demo','Demo',?)`, args: [T0] });
  await client.execute({
    sql: `UPDATE tenants SET autonomy_envelope_json = ? WHERE id = 'demo'`,
    args: [JSON.stringify({
      envelope_version: "env-v1", enabled: true,
      classes: ["SOFT_RETRYABLE", "HARD_METHOD_DEAD", "NETWORK_TIMEOUT"],
      channels: ["RETRY_NOW", "RETRY_PAYDAY", "ALTERNATE_UPI_LINK"],
      max_attempts: 10, max_amount_paise: 10_000_000, require_quiet_ok: false,
    })],
  });
});

async function createStuckIntent(intentId: string, custId: string, status: string, createdAtUtc: string) {
  await client.execute({
    sql: `INSERT OR IGNORE INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,channel_responsiveness,opted_out,prior_success_count,joined_at_utc) VALUES (?,'demo','Test','+919000000000','x@test.com','{}',0.7,0,5,?)`,
    args: [custId, T0],
  });
  await client.execute({
    sql: `INSERT OR IGNORE INTO payment_events (id,tenant_id,customer_id,rzp_payment_id,subscription_id,amount_paise,failure_code,failure_class_hint,source,occurred_at_utc,ingested_at_utc) VALUES (?,'demo',?,NULL,NULL,10000,'INSUFFICIENT_FUNDS','SEED','SEED',?,?)`,
    args: [`evt_${intentId}`, custId, T0, T0],
  });
  await client.execute({
    sql: `INSERT OR IGNORE INTO proposals (id,event_id,customer_id,model_version_id,policy_version,action_json,ev_paise,confidence,attributions_json,narrative,state,state_version,dedupe_key,feature_version,created_at_utc,updated_at_utc) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      `prop_${intentId}`, `evt_${intentId}`, custId, modelId, "v1",
      JSON.stringify({ action: "RETRY_NOW" }), 5000, 0.7, "[]", null, "EXECUTING", 0,
      `dedupe_${intentId}`, "feat-v1", T0, T0,
    ],
  });
  await client.execute({
    sql: `INSERT OR IGNORE INTO payment_intents (id,client_idem_key,proposal_id,customer_id,tenant_id,amount_paise,status,client_visible,created_at_utc) VALUES (?,?,?,?,?,?,?, ?, ?)`,
    args: [intentId, `idem_${intentId}`, `prop_${intentId}`, custId, "demo", 10000, status, status === "UNKNOWN" ? "UNKNOWN" : "PROCESSING", createdAtUtc],
  });
}

describe("F-002: Reconciliation worker", () => {
  it("no Math.random() in reconciliation.ts — uses deterministic hashSeed", () => {
    const src = readFileSync("packages/core/src/executor/reconciliation.ts", "utf8");
    // Only actual invocations are forbidden; comments may reference Math.random for documentation
    expect(src).not.toMatch(/Math\.random\s*\(/);
    expect(src).toContain("hashSeed");
  });

  it("calculateBackoffMs is deterministic — same input → same output", () => {
    const a = calculateBackoffMs(2);
    const b = calculateBackoffMs(2);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(6400); // 8000 * 0.8
    expect(a).toBeLessThanOrEqual(9600);    // 8000 * 1.2
  });

  it("gateway returns captured → intent becomes SUCCEEDED", async () => {
    const intentId = "pint_recon_captured";
    await createStuckIntent(intentId, "cust_recon_1", "UNKNOWN", T0);

    const gateway: ReconcileGateway = {
      async fetchPayment() {
        return {
          providerPaymentId: "pay_captured_1",
          providerOrderId: "order_1",
          status: "captured" as const,
          amountPaise: 10000,
          currency: "INR",
        };
      },
    };

    const result = await reconcilePaymentIntent(client, gateway, intentId, NOW);
    expect(result.resolved).toBe(true);
    expect(result.knowledgeStatus).toBe("RESOLVED_SUCCESS");
    expect(result.reconciliationState).toBe("RECONCILED");

    const row = await client.execute({ sql: `SELECT status FROM payment_intents WHERE id = ?`, args: [intentId] });
    expect(String(row.rows[0]!.status)).toBe("SUCCEEDED");
  });

  it("gateway returns failed → intent becomes FAILED", async () => {
    const intentId = "pint_recon_failed";
    await createStuckIntent(intentId, "cust_recon_2", "UNKNOWN", T0);

    const gateway: ReconcileGateway = {
      async fetchPayment() {
        return {
          providerPaymentId: "pay_failed_1",
          providerOrderId: "order_2",
          status: "failed" as const,
          amountPaise: 10000,
          currency: "INR",
          errorCode: "RZP_FAILED",
          errorDescription: "Payment failed",
        };
      },
    };

    const result = await reconcilePaymentIntent(client, gateway, intentId, NOW);
    expect(result.resolved).toBe(true);
    expect(result.knowledgeStatus).toBe("RESOLVED_FAILED");

    const row = await client.execute({ sql: `SELECT status FROM payment_intents WHERE id = ?`, args: [intentId] });
    expect(String(row.rows[0]!.status)).toBe("FAILED");
  });

  it("gateway returns null / pending → intent stays UNKNOWN (no premature FAILED)", async () => {
    const intentId = "pint_recon_pending";
    await createStuckIntent(intentId, "cust_recon_3", "UNKNOWN", isoUtc(NOW - 60_000));

    const gateway: ReconcileGateway = {
      async fetchPayment() { return null; },
    };

    const result = await reconcilePaymentIntent(client, gateway, intentId, NOW);
    expect(result.resolved).toBe(false);
    expect(result.knowledgeStatus).toBe("UNRESOLVED_UNKNOWN");
    expect(result.reconciliationState).toBe("RECONCILING");

    // Must NOT have been marked FAILED — invariant: never auto-fail on timeout
    const row = await client.execute({ sql: `SELECT status FROM payment_intents WHERE id = ?`, args: [intentId] });
    expect(String(row.rows[0]!.status)).toBe("UNKNOWN");
  });

  it("gateway outage → stays UNRESOLVED_UNKNOWN, error surfaced", async () => {
    const intentId = "pint_recon_outage";
    await createStuckIntent(intentId, "cust_recon_4", "UNKNOWN", isoUtc(NOW - 60_000));

    const gateway: ReconcileGateway = {
      async fetchPayment() { throw new Error("gateway timeout"); },
    };

    const result = await reconcilePaymentIntent(client, gateway, intentId, NOW);
    expect(result.resolved).toBe(false);
    expect(result.knowledgeStatus).toBe("UNRESOLVED_UNKNOWN");
    expect(result.error).toBe("gateway timeout");
  });

  it("TTL expiry (5 min) → RECONCILIATION_EXHAUSTED, never FAILED", async () => {
    const intentId = "pint_recon_ttl";
    // Created 10 minutes ago — well past 5m TTL
    await createStuckIntent(intentId, "cust_recon_5", "UNKNOWN", isoUtc(NOW - 10 * 60 * 1000));

    const gateway: ReconcileGateway = {
      async fetchPayment() { return null; },
    };

    const result = await reconcilePaymentIntent(client, gateway, intentId, NOW);
    expect(result.reconciliationState).toBe("RECONCILIATION_EXHAUSTED");
    expect(result.knowledgeStatus).toBe("UNRESOLVED_UNKNOWN");

    // Still UNKNOWN, not FAILED
    const row = await client.execute({ sql: `SELECT status FROM payment_intents WHERE id = ?`, args: [intentId] });
    expect(String(row.rows[0]!.status)).toBe("UNKNOWN");

    // Audit alarm logged
    const audit = await client.execute({
      sql: `SELECT payload_json FROM audit_log WHERE event_id = ? AND entry_type = 'TRIGGER'`,
      args: [intentId],
    });
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(String(audit.rows[0]!.payload_json));
    expect(payload.alarm).toBe("RECONCILIATION_EXHAUSTED");
  });

  it("sweepStuckIntents claims and reconciles eligible intents", async () => {
    const intentId = "pint_sweep_1";
    await createStuckIntent(intentId, "cust_sweep_1", "UNKNOWN", isoUtc(NOW - 5000));

    const gateway: ReconcileGateway = {
      async fetchPayment() {
        return {
          providerPaymentId: "pay_sweep_1",
          providerOrderId: "order_sweep_1",
          status: "captured" as const,
          amountPaise: 10000,
          currency: "INR",
        };
      },
    };

    const count = await sweepStuckIntents(client, gateway, NOW);
    expect(count).toBeGreaterThanOrEqual(1);

    const row = await client.execute({ sql: `SELECT status FROM payment_intents WHERE id = ?`, args: [intentId] });
    expect(String(row.rows[0]!.status)).toBe("SUCCEEDED");
  });
});
