/**
 * F-001: PaymentIntent State Machine Correctness
 *
 * Verifies idempotency and lost-response handling against the real executor path:
 *  (1) double-charge protection with same idempotency key
 *  (2) lost response leaves UNKNOWN state
 *  (3) concurrent attempts resolve to single charge
 *
 * Track 3 relevance: "Zero double-debits" is in the brief.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { saveModel } from "../../packages/ml/src/registry.js";
import { buildArtifact } from "../../packages/ml/src/artifact.js";
import { FEATURE_NAMES } from "../../packages/ml/src/features.js";
import {
  executePaymentIntent,
  findIntent,
  getBalance,
  reconcileIntent,
  type ChargeProvider,
} from "../../packages/core/src/executor/payment_intent.js";
import { MockRazorpayProvider } from "../../packages/trial/src/provider.js";
import { isoUtc } from "@arbiter/shared";

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
      classes: ["SOFT_RETRYABLE", "HARD_METHOD_DEAD", "NETWORK_TIMEOUT", "RISK_FLAGGED"],
      channels: ["RETRY_NOW", "RETRY_PAYDAY", "ALTERNATE_UPI_LINK", "REMINDER_LINK"],
      max_attempts: 10, max_amount_paise: 10_000_000, require_quiet_ok: false,
    })],
  });
  // Seed initial balance for ledger checks
  await client.execute({
    sql: `INSERT INTO account_balances (customer_id, balance_paise, updated_at_utc) VALUES ('cust_pi_1', 100000, ?) ON CONFLICT(customer_id) DO NOTHING`,
    args: [T0],
  });
  await client.execute({
    sql: `INSERT INTO account_balances (customer_id, balance_paise, updated_at_utc) VALUES ('cust_pi_2', 100000, ?) ON CONFLICT(customer_id) DO NOTHING`,
    args: [T0],
  });
  await client.execute({
    sql: `INSERT INTO account_balances (customer_id, balance_paise, updated_at_utc) VALUES ('cust_pi_3', 100000, ?) ON CONFLICT(customer_id) DO NOTHING`,
    args: [T0],
  });
});

async function createCustomer(custId: string) {
  await client.execute({
    sql: `INSERT OR IGNORE INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,channel_responsiveness,opted_out,prior_success_count,joined_at_utc) VALUES (?,'demo','Test','+919000000000','x@test.com','{}',0.7,0,5,?)`,
    args: [custId, T0],
  });
  await client.execute({
    sql: `INSERT OR IGNORE INTO account_balances (customer_id, balance_paise, updated_at_utc) VALUES (?, 100000, ?)`,
    args: [custId, T0],
  });
}

async function createProposal(proposalId: string, eventId: string, custId: string, amountPaise: number, failureCode: string) {
  await createCustomer(custId);
  await client.execute({
    sql: `INSERT OR IGNORE INTO payment_events (id,tenant_id,customer_id,rzp_payment_id,subscription_id,amount_paise,failure_code,failure_class_hint,source,occurred_at_utc,ingested_at_utc) VALUES (?,'demo',?,NULL,NULL,?,?,?,'SEED',?,?)`,
    args: [eventId, custId, amountPaise, failureCode, failureCode.split("_")[0] ?? "UNKNOWN", T0, T0],
  });
  await client.execute({
    sql: `INSERT OR IGNORE INTO proposals (id,event_id,customer_id,model_version_id,policy_version,action_json,ev_paise,confidence,attributions_json,narrative,state,state_version,dedupe_key,feature_version,created_at_utc,updated_at_utc) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      proposalId, eventId, custId, modelId, "v1",
      JSON.stringify({ action: "RETRY_NOW", failureClass: "SOFT_RETRYABLE" }),
      5000, 0.7, "[]", null, "AUTO_APPROVED", 0,
      `dedupe_${proposalId}`, "feat-v1", T0, T0,
    ],
  });
}

describe("F-001: PaymentIntent safety", () => {
  it("(1) double-charge protection — same idempotency key never debits twice", async () => {
    const custId = "cust_pi_1";
    const eventId = "evt_pi_double_1";
    const proposalId = "prop_pi_double_1";
    const idemKey = "idem_double_1";
    await createProposal(proposalId, eventId, custId, 5000, "INSUFFICIENT_FUNDS");

    const provider = new MockRazorpayProvider();

    // First charge — should succeed and debit once
    const r1 = await executePaymentIntent(client, {
      clientIdemKey: idemKey,
      proposalId,
      scenario: "successful_payment",
      provider,
      nowMs: NOW,
    });
    expect(r1.clientVisible).toBe("SUCCEEDED");
    expect(r1.intentState).toBe("SUCCEEDED");
    expect(r1.idempotent).toBe(false);
    expect(r1.reExecuted).toBe(true);

    const balanceAfterFirst = await getBalance(client, custId);

    // Count ledger debits for this idem key — must be exactly 1
    const ledger1 = await client.execute({
      sql: `SELECT COUNT(*) as cnt FROM ledger_entries WHERE idem_key = ? AND kind = 'DEBIT'`,
      args: [idemKey],
    });
    expect(Number(ledger1.rows[0]!.cnt)).toBe(1);

    // Second call with SAME idempotency key — must be idempotent, no second debit
    // Need a second proposal for the same event? No — same proposalId is fine because
    // idempotency is keyed by clientIdemKey, not proposalId. The executor short-circuits.
    const r2 = await executePaymentIntent(client, {
      clientIdemKey: idemKey,
      proposalId,
      scenario: "successful_payment",
      provider,
      nowMs: NOW + 1000,
    });
    expect(r2.idempotent).toBe(true);
    expect(r2.reExecuted).toBe(false);
    expect(r2.clientVisible).toBe("SUCCEEDED");

    // Ledger still exactly 1 debit — no double-charge
    const ledger2 = await client.execute({
      sql: `SELECT COUNT(*) as cnt FROM ledger_entries WHERE idem_key = ? AND kind = 'DEBIT'`,
      args: [idemKey],
    });
    expect(Number(ledger2.rows[0]!.cnt)).toBe(1);

    const balanceAfterSecond = await getBalance(client, custId);
    expect(balanceAfterSecond).toBe(balanceAfterFirst);

    // Payment intents table must have exactly 1 row for this key
    const intents = await client.execute({
      sql: `SELECT COUNT(*) as cnt FROM payment_intents WHERE client_idem_key = ?`,
      args: [idemKey],
    });
    expect(Number(intents.rows[0]!.cnt)).toBe(1);
  });

  it("(2) lost response leaves UNKNOWN state — charge applied, client told to wait", async () => {
    const custId = "cust_pi_2";
    const eventId = "evt_pi_lost_1";
    const proposalId = "prop_pi_lost_1";
    const idemKey = "idem_lost_1";
    await createProposal(proposalId, eventId, custId, 7500, "GATEWAY_TIMEOUT");

    const provider = new MockRazorpayProvider();

    const r = await executePaymentIntent(client, {
      clientIdemKey: idemKey,
      proposalId,
      scenario: "success_lost_response",
      provider,
      nowMs: NOW,
    });

    // Lost response: provider DID charge, but delivery failed
    expect(r.clientVisible).toBe("UNKNOWN");
    expect(r.intentState).toBe("SUCCEEDED"); // DB intent is SUCCEEDED (charge applied)
    // But clientVisible is UNKNOWN — caller must not retry blindly
    // Actually check: TERMINAL_SUCCESS includes lost_response → intent SUCCEEDED, but
    // clientVisible = UNKNOWN when delivered=false. The ledger IS debited.
    // Let's verify the ledger was debited exactly once (charge happened)
    const ledger = await client.execute({
      sql: `SELECT COUNT(*) as cnt FROM ledger_entries WHERE idem_key = ? AND kind = 'DEBIT'`,
      args: [idemKey],
    });
    // lost_response is in TERMINAL_SUCCESS → debitLedger is called
    expect(Number(ledger.rows[0]!.cnt)).toBe(1);

    // Intent row must reflect UNKNOWN clientVisible
    const intent = await findIntent(client, idemKey);
    expect(intent).not.toBeNull();
    // The intent's clientVisible should be UNKNOWN (not SUCCEEDED)
    expect(intent!.clientVisible).toBe("UNKNOWN");
  });

  it("(3) concurrent attempts resolve to single charge — only one debit", async () => {
    const custId = "cust_pi_3";
    const eventId = "evt_pi_concurrent_1";
    const proposalId = "prop_pi_concurrent_1";
    const idemKey = "idem_concurrent_1";
    await createProposal(proposalId, eventId, custId, 3000, "INSUFFICIENT_FUNDS");

    // Two concurrent calls with same idempotency key
    const provider1 = new MockRazorpayProvider();
    const provider2 = new MockRazorpayProvider();

    const [r1, r2] = await Promise.all([
      executePaymentIntent(client, {
        clientIdemKey: idemKey,
        proposalId,
        scenario: "concurrent_attempts",
        provider: provider1,
        nowMs: NOW,
      }),
      executePaymentIntent(client, {
        clientIdemKey: idemKey,
        proposalId,
        scenario: "concurrent_attempts",
        provider: provider2,
        nowMs: NOW,
      }),
    ]);

    // At least one must succeed, the other must be idempotent or also succeed
    // But critically: only ONE ledger debit
    const ledger = await client.execute({
      sql: `SELECT COUNT(*) as cnt FROM ledger_entries WHERE idem_key = ? AND kind = 'DEBIT'`,
      args: [idemKey],
    });
    expect(Number(ledger.rows[0]!.cnt)).toBe(1);

    // Only ONE intent row
    const intents = await client.execute({
      sql: `SELECT COUNT(*) as cnt FROM payment_intents WHERE client_idem_key = ?`,
      args: [idemKey],
    });
    expect(Number(intents.rows[0]!.cnt)).toBe(1);

    // No double-debit: balance reduced by exactly one amount
    const balance = await getBalance(client, custId);
    // Started at 100000, one debit of 3000 → 97000
    expect(balance).toBe(97000);

    // At least one result should be success or idempotent success
    const successes = [r1, r2].filter((r) => r.clientVisible === "SUCCEEDED" || r.clientVisible === "UNKNOWN");
    expect(successes.length).toBeGreaterThanOrEqual(1);
  });

  it("reconcileIntent settles UNKNOWN exactly once — no second debit", async () => {
    const custId = "cust_pi_reconcile";
    const eventId = "evt_pi_reconcile_1";
    const proposalId = "prop_pi_reconcile_1";
    const idemKey = "idem_reconcile_1";
    await createProposal(proposalId, eventId, custId, 4000, "GATEWAY_TIMEOUT");

    // Create an uncertain intent (timeout → UNKNOWN)
    const slowProvider: ChargeProvider = {
      name: "slow",
      async charge() {
        return { status: "timeout" as const, delivered: false, latencyMs: 30000, errorCode: "RZP_TIMEOUT", errorMessage: "timeout" };
      },
    };

    const r = await executePaymentIntent(client, {
      clientIdemKey: idemKey,
      proposalId,
      scenario: "gateway_timeout",
      provider: slowProvider,
      nowMs: NOW,
    });
    expect(r.clientVisible).toBe("UNKNOWN");
    expect(r.intentState).toBe("UNKNOWN");

    // No debit yet for uncertain
    const ledgerBefore = await client.execute({
      sql: `SELECT COUNT(*) as cnt FROM ledger_entries WHERE idem_key = ? AND kind = 'DEBIT'`,
      args: [idemKey],
    });
    expect(Number(ledgerBefore.rows[0]!.cnt)).toBe(0);

    // Reconcile as SUCCEEDED — should debit exactly once
    const rec1 = await reconcileIntent(client, idemKey, "SUCCEEDED", NOW + 60000);
    expect(rec1).not.toBeNull();
    expect(rec1!.clientVisible).toBe("SUCCEEDED");

    const ledgerAfter1 = await client.execute({
      sql: `SELECT COUNT(*) as cnt FROM ledger_entries WHERE idem_key = ? AND kind = 'DEBIT'`,
      args: [idemKey],
    });
    expect(Number(ledgerAfter1.rows[0]!.cnt)).toBe(1);

    // Second reconcile — must be idempotent, no second debit
    const rec2 = await reconcileIntent(client, idemKey, "SUCCEEDED", NOW + 120000);
    expect(rec2).not.toBeNull();
    expect(rec2!.idempotent).toBe(true);

    const ledgerAfter2 = await client.execute({
      sql: `SELECT COUNT(*) as cnt FROM ledger_entries WHERE idem_key = ? AND kind = 'DEBIT'`,
      args: [idemKey],
    });
    expect(Number(ledgerAfter2.rows[0]!.cnt)).toBe(1);
  });
});
