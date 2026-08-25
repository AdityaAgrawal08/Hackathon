/**
 * T5 validation gates:
 *  - valid signature accepted; event persisted with unresolved customer
 *  - invalid/absent signature rejected AND logged (security REFUSAL row)
 *  - malformed JSON rejected
 *  - duplicate delivery ⇒ DUPLICATE, exactly ONE event row, swallow counted
 *  - non-failure events acknowledged as IGNORED
 *  - replay: full demo corpus inserts; second replay is fully idempotent
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { createHmac } from "node:crypto";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { processWebhook, verifySignature } from "../../packages/core/src/ingest/webhook.js";
import { replayCorpus } from "../../packages/core/src/ingest/replay.js";
import { generateCorpus } from "../../packages/seed/src/generate.js";

const SECRET = "test_whsec";
const NOW = Date.UTC(2026, 7, 25, 9, 0, 0);
const nowMs = () => NOW;

let client: Client;

function signedBody(body: string): string {
  return createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
}

function failurePayload(paymentId: string): string {
  return JSON.stringify({
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          id: paymentId,
          amount: 49900,
          status: "failed",
          error_description: "INSUFFICIENT_FUNDS at issuing bank",
        },
      },
      subscription: { entity: { id: "sub_demo00001" } },
    },
  });
}

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await runMigrations(client);
});

describe("webhook ingestion (T5)", () => {
  it("accepts properly signed failure and persists an unresolved event", async () => {
    const body = failurePayload("payT001");
    const res = await processWebhook({ client, nowMs }, body, signedBody(body), SECRET);
    expect(res.status).toBe("ACCEPTED");
    const r = await client.execute({
      sql: `SELECT customer_id, amount_paise, failure_code, source FROM payment_events WHERE id='evt_wh_payT001'`,
      args: [],
    });
    expect(r.rows[0]?.customer_id).toBeNull();
    expect(r.rows[0]?.amount_paise).toBe(49900);
    expect(r.rows[0]?.failure_code).toBe("INSUFFICIENT_FUNDS");
    expect(r.rows[0]?.source).toBe("WEBHOOK");
  });

  it("rejects bad signature AND logs a security refusal", async () => {
    const body = failurePayload("payT002");
    const res = await processWebhook({ client, nowMs }, body, "deadbeef", SECRET);
    expect(res.status).toBe("REJECTED");
    const r = await client.execute({
      sql: `SELECT payload_json FROM audit_log WHERE entry_type='REFUSAL' AND actor='SYSTEM'`,
      args: [],
    });
    expect(r.rows.length).toBeGreaterThan(0);
    // nothing persisted
    const e = await client.execute({
      sql: `SELECT count(*) AS n FROM payment_events WHERE rzp_payment_id='payT002'`,
      args: [],
    });
    expect(Number(e.rows[0]?.n)).toBe(0);
  });

  it("rejects malformed json", async () => {
    const body = "{not json";
    const res = await processWebhook(
      { client, nowMs },
      body,
      signedBody(body),
      SECRET,
    );
    expect(res.status).toBe("REJECTED");
    expect(res.reason).toBe("malformed_json");
  });

  it("duplicate delivery ⇒ DUPLICATE, one event row, swallow counted (P1-B8)", async () => {
    const body = failurePayload("payT003");
    const sig = signedBody(body);
    const r1 = await processWebhook({ client, nowMs }, body, sig, SECRET);
    const r2 = await processWebhook({ client, nowMs }, body, sig, SECRET);
    expect(r1.status).toBe("ACCEPTED");
    expect(r2.status).toBe("DUPLICATE");
    const rows = await client.execute({
      sql: `SELECT count(*) AS n FROM payment_events WHERE rzp_payment_id='payT003'`,
      args: [],
    });
    expect(Number(rows.rows[0]?.n)).toBe(1);
    const dd = await client.execute({
      sql: `SELECT swallow_count FROM webhook_dedupe WHERE provider_event_id='evt_wh_payT003'`,
      args: [],
    });
    expect(Number(dd.rows[0]?.swallow_count)).toBe(1);
  });

  it("ignores non-failure events", async () => {
    const body = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "payOK1", amount: 100, status: "captured" } } },
    });
    const res = await processWebhook(
      { client, nowMs },
      body,
      signedBody(body),
      SECRET,
    );
    expect(res.status).toBe("IGNORED");
  });

  it("verifySignature is false for absent header", () => {
    expect(verifySignature("{}", null, SECRET)).toBe(false);
  });
});

describe("replay ingestion (T5)", () => {
  it("inserts full demo corpus; second pass fully idempotent", async () => {
    const corpus = generateCorpus("demo", { customerCount: 60, targetEvents: 230 });
    const r1 = await replayCorpus(client, corpus);
    expect(r1.events).toBe(230);
    expect(r1.customers).toBe(60);
    expect(r1.duplicates).toBe(0);

    const r2 = await replayCorpus(client, corpus);
    expect(r2.duplicates).toBe(230);
    expect(r2.events).toBe(0);

    const total = await client.execute({
      sql: `SELECT count(*) AS n FROM payment_events WHERE source='SEED'`,
      args: [],
    });
    expect(Number(total.rows[0]?.n)).toBe(230);
  });
});
