/**
 * F-003: Webhook Race — payment.captured arrives before payment.failed
 *
 * Verifies that webhook dedup and event ordering handle out-of-order delivery:
 *  - Duplicate deliveries are swallowed (webhook_dedupe / inbox_events)
 *  - Out-of-order captured before failed produces consistent state
 *  - inbox_events idempotency prevents double settlement
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { processWebhook, ingestDomainWebhook } from "../../packages/core/src/ingest/webhook.js";
import { createHmac } from "node:crypto";

const T0 = "2026-01-05T09:00:00.000Z";
const NOW = Date.UTC(2026, 1, 15, 10, 0, 0);
const WEBHOOK_SECRET = "test_webhook_secret_12345";

function signWebhook(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

let client: Client;

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await runMigrations(client);
  await client.execute({ sql: `INSERT INTO tenants (id,name,created_at_utc) VALUES ('demo','Demo',?)`, args: [T0] });
});

describe("F-003: Webhook race — out-of-order and duplicate handling", () => {
  it("duplicate webhook deliveries are deduped — second is DUPLICATE", async () => {
    const payId = "pay_dedupe_test_1";
    const rawBody = JSON.stringify({
      event: "payment.failed",
      payload: {
        payment: { entity: { id: payId, amount: 50000, status: "failed", error_description: "INSUFFICIENT_FUNDS", error_source: "customer" } },
      },
    });
    const sig = signWebhook(rawBody, WEBHOOK_SECRET);

    const r1 = await processWebhook({ client, nowMs: () => NOW, tenantId: "demo" }, rawBody, sig, WEBHOOK_SECRET);
    expect(r1.status).toBe("ACCEPTED");

    const r2 = await processWebhook({ client, nowMs: () => NOW + 1000, tenantId: "demo" }, rawBody, sig, WEBHOOK_SECRET);
    expect(r2.status).toBe("DUPLICATE");

    // Only one payment_event row
    const rows = await client.execute({ sql: `SELECT COUNT(*) as cnt FROM payment_events WHERE rzp_payment_id = ?`, args: [payId] });
    expect(Number(rows.rows[0]!.cnt)).toBe(1);

    // webhook_dedupe swallow_count incremented
    const dedupe = await client.execute({ sql: `SELECT swallow_count FROM webhook_dedupe WHERE provider_event_id = ?`, args: [`evt_wh_${payId}`] });
    expect(Number(dedupe.rows[0]!.swallow_count)).toBe(1);
  });

  it("inbox_events — duplicate event ID with same payload is DUPLICATE", async () => {
    const eventId = "evt_inbox_dedupe_1";
    const rawBody = JSON.stringify({
      id: eventId,
      event: "payment.failed",
      payload: { payment: { entity: { id: "pay_inbox_1", order_id: "order_inbox_1", amount: 10000, status: "failed" } } },
    });
    const sig = signWebhook(rawBody, WEBHOOK_SECRET);

    const r1 = await ingestDomainWebhook({ client, rawBody, signature: sig, webhookSecret: WEBHOOK_SECRET, provider: "razorpay", nowMs: NOW });
    expect(r1.statusCode).toBe(200);
    expect(r1.status).toBe("ACCEPTED");

    const r2 = await ingestDomainWebhook({ client, rawBody, signature: sig, webhookSecret: WEBHOOK_SECRET, provider: "razorpay", nowMs: NOW + 1000 });
    expect(r2.statusCode).toBe(200);
    expect(r2.status).toBe("DUPLICATE");
  });

  it("inbox_events — same event ID with different payload is SECURITY_ANOMALY", async () => {
    const eventId = "evt_inbox_anomaly_1";
    const body1 = JSON.stringify({
      id: eventId,
      event: "payment.failed",
      payload: { payment: { entity: { id: "pay_anom_1", order_id: "order_anom_1", amount: 10000, status: "failed" } } },
    });
    const body2 = JSON.stringify({
      id: eventId,
      event: "payment.failed",
      payload: { payment: { entity: { id: "pay_anom_1", order_id: "order_anom_1", amount: 99999, status: "failed" } } },
    });
    const sig1 = signWebhook(body1, WEBHOOK_SECRET);

    const r1 = await ingestDomainWebhook({ client, rawBody: body1, signature: sig1, webhookSecret: WEBHOOK_SECRET, provider: "razorpay", nowMs: NOW });
    expect(r1.status).toBe("ACCEPTED");

    const sig2 = signWebhook(body2, WEBHOOK_SECRET);
    const r2 = await ingestDomainWebhook({ client, rawBody: body2, signature: sig2, webhookSecret: WEBHOOK_SECRET, provider: "razorpay", nowMs: NOW + 1000 });
    expect(r2.status).toBe("SECURITY_ANOMALY");
    expect(r2.statusCode).toBe(400);
  });

  it("out-of-order: payment.captured before payment.failed — consistent state, no lost settlement", async () => {
    // Simulate: Razorpay sends payment.captured (success) but client already saw failure
    // The inbox projector should NOT create a phantom settlement for a non-existent intent
    const orderId = "order_race_1";
    const payId = "pay_race_1";
    const token = "tok_race_1";

    // Create a checkout session and a PROCESSING intent (as if payment is in-flight)
    await client.execute({
      sql: `INSERT OR IGNORE INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,channel_responsiveness,opted_out,prior_success_count,joined_at_utc) VALUES ('cust_race_1','demo','Race Test','+919000000001','race@test.com','{}',0.7,0,5,?)`,
      args: [T0],
    });
    await client.execute({
      sql: `INSERT OR IGNORE INTO checkout_sessions (token,tenant_id,order_id,amount_paise,currency,payment_mode,expires_at_utc,created_at_utc) VALUES (?,?,?,?,?,?,?,?)`,
      args: [token, "demo", orderId, 50000, "INR", "LOCAL_SANDBOX", "2099-01-01T00:00:00.000Z", T0],
    });
    await client.execute({
      sql: `INSERT OR IGNORE INTO payment_intents (id,client_idem_key,proposal_id,customer_id,tenant_id,order_id,checkout_token,amount_paise,status,client_visible,created_at_utc) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: ["pint_race_1", "idem_race_1", "prop_race_1", "cust_race_1", "demo", orderId, token, 50000, "PROCESSING", "PROCESSING", T0],
    });

    // Now deliver payment.captured webhook OUT OF ORDER (before any failed event)
    const capturedBody = JSON.stringify({
      id: "evt_race_captured",
      event: "payment.captured",
      payload: { payment: { entity: { id: payId, order_id: orderId, amount: 50000, status: "captured" } } },
    });
    const sigCaptured = signWebhook(capturedBody, WEBHOOK_SECRET);

    const rCaptured = await ingestDomainWebhook({
      client, rawBody: capturedBody, signature: sigCaptured, webhookSecret: WEBHOOK_SECRET, provider: "razorpay", nowMs: NOW,
    });
    expect(rCaptured.statusCode).toBe(200);
    expect(rCaptured.status).toBe("ACCEPTED");

    // Give the async projector a moment
    await new Promise((r) => setTimeout(r, 100));

    // Intent should now be SUCCEEDED (captured wins)
    const intentAfterCaptured = await client.execute({ sql: `SELECT status FROM payment_intents WHERE id = 'pint_race_1'`, args: [] });
    expect(String(intentAfterCaptured.rows[0]!.status)).toBe("SUCCEEDED");

    // Settlement must exist exactly once
    const settlements = await client.execute({ sql: `SELECT COUNT(*) as cnt FROM local_settlements WHERE payment_intent_id = 'pint_race_1'`, args: [] });
    expect(Number(settlements.rows[0]!.cnt)).toBe(1);

    // Now deliver a duplicate captured — should be idempotent, no second settlement
    const rDup = await ingestDomainWebhook({
      client, rawBody: capturedBody, signature: sigCaptured, webhookSecret: WEBHOOK_SECRET, provider: "razorpay", nowMs: NOW + 2000,
    });
    expect(rDup.status).toBe("DUPLICATE");

    await new Promise((r) => setTimeout(r, 100));
    const settlementsAfterDup = await client.execute({ sql: `SELECT COUNT(*) as cnt FROM local_settlements WHERE payment_intent_id = 'pint_race_1'`, args: [] });
    expect(Number(settlementsAfterDup.rows[0]!.cnt)).toBe(1);
  });

  it("invalid signature is REJECTED — not ingested", async () => {
    const rawBody = JSON.stringify({
      event: "payment.failed",
      payload: { payment: { entity: { id: "pay_bad_sig", amount: 10000, status: "failed", error_description: "fail" } } },
    });

    const r = await processWebhook({ client, nowMs: () => NOW, tenantId: "demo" }, rawBody, "bad_signature_hex", WEBHOOK_SECRET);
    expect(r.status).toBe("REJECTED");
    expect(r.reason).toBe("invalid_signature");

    // No event row created
    const rows = await client.execute({ sql: `SELECT COUNT(*) as cnt FROM payment_events WHERE rzp_payment_id = 'pay_bad_sig'`, args: [] });
    expect(Number(rows.rows[0]!.cnt)).toBe(0);
  });
});
