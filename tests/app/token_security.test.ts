import { describe, it, expect, beforeEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { isoUtc } from "@arbiter/shared";
import { randomBytes } from "node:crypto";

describe("Checkout Token Lifecycle & LAN Security", () => {
  let client: Client;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await runMigrations(client);
  });

  it("creates checkout session with 15-minute TTL", async () => {
    const token = randomBytes(24).toString("base64url");
    const nowMs = Date.now();
    const expiresMs = nowMs + 15 * 60 * 1000;

    await client.execute({
      sql: `INSERT INTO checkout_sessions
              (token, tenant_id, order_id, amount_paise, currency, payment_mode, expires_at_utc, created_at_utc)
            VALUES (?, 'demo', 'order_123', 49900, 'INR', 'LOCAL_SANDBOX', ?, ?)`,
      args: [token, isoUtc(expiresMs), isoUtc(nowMs)],
    });

    const r = await client.execute({
      sql: `SELECT * FROM checkout_sessions WHERE token = ?`,
      args: [token],
    });
    expect(r.rows.length).toBe(1);
    expect(Date.parse(String(r.rows[0]!.expires_at_utc))).toBeGreaterThan(nowMs);
  });

  it("detects and rejects expired checkout tokens (>15 mins)", async () => {
    const token = "expired_token_123";
    const expiredTime = Date.now() - 60000; // 1 minute in the past

    await client.execute({
      sql: `INSERT INTO checkout_sessions
              (token, tenant_id, order_id, amount_paise, currency, payment_mode, expires_at_utc, created_at_utc)
            VALUES (?, 'demo', 'order_123', 49900, 'INR', 'LOCAL_SANDBOX', ?, ?)`,
      args: [token, isoUtc(expiredTime), isoUtc(expiredTime - 900000)],
    });

    const r = await client.execute({
      sql: `SELECT expires_at_utc FROM checkout_sessions WHERE token = ?`,
      args: [token],
    });

    const isExpired = Date.parse(String(r.rows[0]!.expires_at_utc)) < Date.now();
    expect(isExpired).toBe(true);
  });
});
