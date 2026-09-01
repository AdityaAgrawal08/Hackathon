/**
 * F-004: UNKNOWN Payment State Handling — 24h auto-escalate to human review
 *
 * When a payment intent is UNKNOWN (provider charged but response lost) for >24h,
 * it is auto-escalated to human review with a "check with provider" action.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { escalateStaleUnknownIntents } from "../../packages/core/src/executor/reconciliation.js";
import { UNKNOWN_ESCALATION_MS } from "../../packages/core/src/constants.js";
import { isoUtc } from "@arbiter/shared";

const T0 = "2026-01-05T09:00:00.000Z";
const NOW = Date.UTC(2026, 1, 15, 10, 0, 0);

let client: Client;

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await runMigrations(client);
  await client.execute({ sql: `INSERT INTO tenants (id,name,created_at_utc) VALUES ('demo','Demo',?)`, args: [T0] });
  await client.execute({
    sql: `INSERT OR IGNORE INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,channel_responsiveness,opted_out,prior_success_count,joined_at_utc) VALUES ('cust_esc_1','demo','Esc Test','+919000000001','esc@test.com','{}',0.7,0,5,?)`,
    args: [T0],
  });
});

async function createUnknownIntent(intentId: string, createdAtUtc: string) {
  await client.execute({
    sql: `INSERT OR IGNORE INTO payment_intents (id,client_idem_key,proposal_id,customer_id,tenant_id,amount_paise,status,client_visible,created_at_utc) VALUES (?,?,?,?,?,?,?,?,?)`,
    args: [intentId, `idem_${intentId}`, `prop_${intentId}`, "cust_esc_1", "demo", 5000, "UNKNOWN", "UNKNOWN", createdAtUtc],
  });
}

describe("F-004: UNKNOWN auto-escalate after 24h", () => {
  it("UNKNOWN_ESCALATION_MS is 24 hours", () => {
    expect(UNKNOWN_ESCALATION_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("UNKNOWN intent older than 24h is escalated", async () => {
    const intentId = "pint_esc_old";
    const oldTime = isoUtc(NOW - 25 * 60 * 60 * 1000); // 25h ago
    await createUnknownIntent(intentId, oldTime);

    const count = await escalateStaleUnknownIntents(client, NOW);
    expect(count).toBeGreaterThanOrEqual(1);

    // Audit log must contain escalation entry
    const audit = await client.execute({
      sql: `SELECT payload_json FROM audit_log WHERE event_id = ? AND entry_type = 'TRIGGER'`,
      args: [intentId],
    });
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(String(audit.rows[0]!.payload_json));
    expect(payload.alarm).toBe("UNKNOWN_ESCALATED");
    expect(payload.action).toBe("check_with_provider");
    expect(payload.intentId).toBe(intentId);
  });

  it("UNKNOWN intent younger than 24h is NOT escalated", async () => {
    const intentId = "pint_esc_fresh";
    const freshTime = isoUtc(NOW - 2 * 60 * 60 * 1000); // 2h ago
    await createUnknownIntent(intentId, freshTime);

    const count = await escalateStaleUnknownIntents(client, NOW);
    // Fresh intent should not be escalated (old one already escalated, so count may be 0)
    // Verify fresh intent has no escalation entry
    const audit = await client.execute({
      sql: `SELECT COUNT(*) as cnt FROM audit_log WHERE event_id = ? AND payload_json LIKE '%UNKNOWN_ESCALATED%'`,
      args: [intentId],
    });
    expect(Number(audit.rows[0]!.cnt)).toBe(0);
  });

  it("SUCCEEDED intent is never escalated even if old", async () => {
    const intentId = "pint_esc_succeeded";
    const oldTime = isoUtc(NOW - 25 * 60 * 60 * 1000);
    await client.execute({
      sql: `INSERT OR IGNORE INTO payment_intents (id,client_idem_key,proposal_id,customer_id,tenant_id,amount_paise,status,client_visible,created_at_utc) VALUES (?,?,?,?,?,?,?,?,?)`,
      args: [intentId, `idem_${intentId}`, `prop_${intentId}`, "cust_esc_1", "demo", 5000, "SUCCEEDED", "SUCCEEDED", oldTime],
    });

    await escalateStaleUnknownIntents(client, NOW);

    const audit = await client.execute({
      sql: `SELECT COUNT(*) as cnt FROM audit_log WHERE event_id = ? AND payload_json LIKE '%UNKNOWN_ESCALATED%'`,
      args: [intentId],
    });
    expect(Number(audit.rows[0]!.cnt)).toBe(0);
  });

  it("escalation is idempotent — second call does not create duplicate audit entry", async () => {
    const intentId = "pint_esc_idem";
    const oldTime = isoUtc(NOW - 25 * 60 * 60 * 1000);
    await createUnknownIntent(intentId, oldTime);

    const count1 = await escalateStaleUnknownIntents(client, NOW);
    expect(count1).toBeGreaterThanOrEqual(1);

    const count2 = await escalateStaleUnknownIntents(client, NOW);
    // Second call should find the existing audit entry and skip
    const audit = await client.execute({
      sql: `SELECT COUNT(*) as cnt FROM audit_log WHERE event_id = ? AND payload_json LIKE '%UNKNOWN_ESCALATED%'`,
      args: [intentId],
    });
    expect(Number(audit.rows[0]!.cnt)).toBe(1);
  });

  it("PROCESSING intent is NOT escalated by UNKNOWN escalator (only UNKNOWN)", async () => {
    const intentId = "pint_esc_processing";
    const oldTime = isoUtc(NOW - 25 * 60 * 60 * 1000);
    await client.execute({
      sql: `INSERT OR IGNORE INTO payment_intents (id,client_idem_key,proposal_id,customer_id,tenant_id,amount_paise,status,client_visible,created_at_utc) VALUES (?,?,?,?,?,?,?,?,?)`,
      args: [intentId, `idem_${intentId}`, `prop_${intentId}`, "cust_esc_1", "demo", 5000, "PROCESSING", "PROCESSING", oldTime],
    });

    await escalateStaleUnknownIntents(client, NOW);

    const audit = await client.execute({
      sql: `SELECT COUNT(*) as cnt FROM audit_log WHERE event_id = ? AND payload_json LIKE '%UNKNOWN_ESCALATED%'`,
      args: [intentId],
    });
    expect(Number(audit.rows[0]!.cnt)).toBe(0);
  });
});
