import { describe, it, expect, beforeEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { ingestDomainWebhook } from "../../packages/core/src/ingest/webhook.js";
import { createHmac } from "node:crypto";

describe("Webhook Ingestion Security & Deduplication", () => {
  let client: Client;
  const secret = "whsec_test_secret_999";

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await runMigrations(client);
  });

  function sign(body: string): string {
    return createHmac("sha256", secret).update(body, "utf8").digest("hex");
  }

  it("accepts valid webhook with correct HMAC-SHA256 signature", async () => {
    const payload = JSON.stringify({
      id: "evt_test_valid_1",
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: "pay_test_123",
            order_id: "order_123",
            amount: 49900,
            status: "captured",
          },
        },
      },
    });

    const sig = sign(payload);
    const res = await ingestDomainWebhook({
      client,
      rawBody: payload,
      signature: sig,
      webhookSecret: secret,
    });

    expect(res.statusCode).toBe(200);
    expect(res.status).toBe("ACCEPTED");
    expect(res.eventId).toBe("evt_test_valid_1");

    // Verify written to inbox_events
    const r = await client.execute({
      sql: `SELECT * FROM inbox_events WHERE id = ?`,
      args: ["evt_test_valid_1"],
    });
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]!.event_type).toBe("payment.captured");
  });

  it("rejects webhook with invalid HMAC signature", async () => {
    const payload = JSON.stringify({ event: "payment.captured" });
    const res = await ingestDomainWebhook({
      client,
      rawBody: payload,
      signature: "invalid_sig_hex_123",
      webhookSecret: secret,
    });

    expect(res.statusCode).toBe(400);
    expect(res.status).toBe("REJECTED");
  });

  it("handles duplicate delivery idempotently with HTTP 200", async () => {
    const payload = JSON.stringify({
      id: "evt_duplicate_test",
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_dup_1", order_id: "order_dup_1", amount: 49900 } } },
    });
    const sig = sign(payload);

    // 1st delivery
    const res1 = await ingestDomainWebhook({
      client,
      rawBody: payload,
      signature: sig,
      webhookSecret: secret,
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.status).toBe("ACCEPTED");

    // 2nd delivery with identical payload
    const res2 = await ingestDomainWebhook({
      client,
      rawBody: payload,
      signature: sig,
      webhookSecret: secret,
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.status).toBe("DUPLICATE");
  });

  it("detects and rejects duplicate event ID with conflicting payload as security anomaly", async () => {
    const payload1 = JSON.stringify({
      id: "evt_anomaly_test",
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_1", amount: 49900 } } },
    });
    const payload2 = JSON.stringify({
      id: "evt_anomaly_test",
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_1", amount: 999900 } } }, // modified amount
    });

    const sig1 = sign(payload1);
    const sig2 = sign(payload2);

    await ingestDomainWebhook({
      client,
      rawBody: payload1,
      signature: sig1,
      webhookSecret: secret,
    });

    // 2nd delivery with same ID but different payload
    const res2 = await ingestDomainWebhook({
      client,
      rawBody: payload2,
      signature: sig2,
      webhookSecret: secret,
    });

    expect(res2.statusCode).toBe(400);
    expect(res2.status).toBe("SECURITY_ANOMALY");
  });
});
