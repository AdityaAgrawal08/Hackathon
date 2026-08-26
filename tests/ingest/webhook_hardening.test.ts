import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { createHmac } from "node:crypto";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { processWebhook, verifySignature } from "../../packages/core/src/ingest/webhook.js";

let client: Client;
const SECRET = "whsec_test_12345";
const NOW = Date.UTC(2026, 1, 20, 10, 0, 0);

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function body(paymentId: string, amount = 49_900): string {
  return JSON.stringify({
    event: "payment.failed",
    payload: {
      payment: { entity: { id: paymentId, amount, status: "failed", error_source: "insufficient funds" } },
    },
  });
}

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await runMigrations(client);
});

describe("webhook signature verification — adversarial", () => {
  it("accepts a correctly signed payload end-to-end", async () => {
    const b = body("pay_ok1");
    const r = await processWebhook({ client, nowMs: () => NOW }, b, sign(b), SECRET);
    expect(r.status).toBe("ACCEPTED");
    expect(r.eventId).toBe("evt_wh_pay_ok1");
  });

  it("rejects a single flipped byte even with valid structure", async () => {
    const b = body("pay_tamper");
    const evil = b.replace('"failed"', '"captured"');
    const r = await processWebhook(
      { client, nowMs: () => NOW },
      evil,
      sign(b),
      SECRET,
    );
    expect(r.status).toBe("REJECTED");
    expect(r.reason).toBe("invalid_signature");
  });

  it("rejects signatures from a wrong secret and same-length junk", async () => {
    const b = body("pay_junk");
    expect(verifySignature(b, sign(b, "whsec_evil"), SECRET)).toBe(false);
    const junkSameLength = "a".repeat(sign(b).length);
    expect(verifySignature(b, junkSameLength, SECRET)).toBe(false);
    expect(verifySignature(b, "", SECRET)).toBe(false);
    expect(verifySignature(b, null, SECRET)).toBe(false);
  });

  it("is deterministic per delivery: replaying identical signed body ⇒ DUPLICATE once", async () => {
    const b = body("pay_dupe", 29_900);
    const sig = sign(b);
    const first = await processWebhook({ client, nowMs: () => NOW }, b, sig, SECRET);
    expect(first.status).toBe("ACCEPTED");
    const second = await processWebhook({ client, nowMs: () => NOW }, b, sig, SECRET);
    expect(second.status).toBe("DUPLICATE");

    const rows = await client.execute({
      sql: `SELECT count(*) n FROM payment_events WHERE id='evt_wh_pay_dupe'`,
    });
    expect(Number(rows.rows[0]!.n)).toBe(1);
  });

  it("duplicate storm of five deliveries yields exactly one event row (P9 scenario 5)", async () => {
    const b = body("pay_storm");
    const sig = sign(b);
    const statuses: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await processWebhook({ client, nowMs: () => NOW + i }, b, sig, SECRET);
      statuses.push(r.status);
      if (r.status === "DUPLICATE") {
        const swallow = await client.execute({
          sql: `SELECT swallow_count FROM webhook_dedupe WHERE provider_event_id='evt_wh_pay_storm'`,
        });
        expect(Number(swallow.rows[0]!.swallow_count)).toBe(i);
      }
    }
    expect(statuses.filter((s) => s === "ACCEPTED")).toHaveLength(1);
    expect(statuses.filter((s) => s === "DUPLICATE")).toHaveLength(4);
  });

  it("schema rejects zero/negative/fractional amounts even when signed (I-5)", async () => {
    for (const bad of [0, -100, 499.5]) {
      const b = JSON.stringify({
        event: "payment.failed",
        payload: {
          payment: { entity: { id: `pay_badamt${bad}`, amount: bad, status: "failed" } },
        },
      });
      const r = await processWebhook(
        { client, nowMs: () => NOW },
        b,
        sign(b),
        SECRET,
      );
      expect(r.status).toBe("REJECTED");
      expect(r.reason).toBe("schema_mismatch");
    }
  });

  it("non-failure events are acknowledged without ingestion", async () => {
    const b = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_captured", amount: 100, status: "captured" } } },
    });
    const r = await processWebhook({ client, nowMs: () => NOW }, b, sign(b), SECRET);
    expect(r.status).toBe("IGNORED");
    const rows = await client.execute({
      sql: `SELECT count(*) n FROM payment_events WHERE id='evt_wh_pay_captured'`,
    });
    expect(Number(rows.rows[0]!.n)).toBe(0);
  });

  it("unicode payloads sign and verify over UTF-8 bytes exactly", async () => {
    const b = JSON.stringify({
      event: "payment.failed",
      payload: {
        payment: {
          entity: { id: "pay_uni₹", amount: 100, status: "failed", notes: { city: "Mumbai ₹" } },
        },
      },
    });
    const r = await processWebhook({ client, nowMs: () => NOW }, b, sign(b), SECRET);
    expect(r.status).toBe("ACCEPTED");
  });

  it("security rejections are ledgered as REFUSAL rows", async () => {
    const before = await client.execute({
      sql: `SELECT count(*) n FROM audit_log WHERE entry_type='REFUSAL'`,
    });
    await processWebhook({ client, nowMs: () => NOW }, body("x"), "badsig", SECRET);
    const after = await client.execute({
      sql: `SELECT count(*) n FROM audit_log WHERE entry_type='REFUSAL'`,
    });
    expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n) + 1);
  });
});
