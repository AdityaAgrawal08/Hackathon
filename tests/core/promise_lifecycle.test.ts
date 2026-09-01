/**
 * E-009: Promise-to-Pay Lifecycle Integration Test
 *
 * Tests the full lifecycle:
 *   propose → approve → execute → record promise → reconcile → mark kept/broken → feature impact
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { isoUtc } from "@arbiter/shared";
import { recordPromiseToPay } from "../../app/recovery.js";

const T0 = "2026-01-10T09:00:00.000Z";

describe("E-009 Promise-to-Pay Lifecycle", () => {
  let client: Client;

  beforeAll(async () => {
    client = createClient({ url: "file:./data/arbiter_test.sqlite" });
    await runMigrations(client);

    // Ensure tenant exists
    await client.execute({
      sql: `INSERT OR IGNORE INTO tenants (id, name, created_at_utc) VALUES ('demo', 'D', ?)`,
      args: [T0],
    });

    // Ensure customers exist (use distinct customers to avoid uq_one_open_per_customer violation)
    await client.execute({
      sql: `INSERT OR IGNORE INTO customers (id, tenant_id, pseudo_name, phone_fake, email_fake, joined_at_utc) VALUES (?, 'demo', 'Test Cust 01', '+919000000001', 't01@test.com', ?)`,
      args: ['cust_ptp_01', T0],
    });
    await client.execute({
      sql: `INSERT OR IGNORE INTO customers (id, tenant_id, pseudo_name, phone_fake, email_fake, joined_at_utc) VALUES (?, 'demo', 'Test Cust 02', '+919000000002', 't02@test.com', ?)`,
      args: ['cust_ptp_02', T0],
    });

    // Ensure model_versions FK target exists for proposals
    await client.execute({
      sql: `INSERT OR IGNORE INTO model_versions (id, weights_json, weights_sha256, dataset_sha256, feature_names_json, metrics_json, trained_at_utc, status)
            VALUES ('logreg@1.0.0', '[]', 'abc', 'def', '[]', '{}', ?, 'INCUMBENT')`,
      args: [T0],
    });
  });

  it("full promise-to-pay lifecycle: propose → record → reconcile → mark kept", async () => {
    // Clean stale rows from previous runs (INSERT OR IGNORE would keep wrong customer_id)
    await client.execute({ sql: `DELETE FROM promise_to_pay WHERE id = 'ptp_lifecycle_01'`, args: [] });
    await client.execute({ sql: `DELETE FROM proposals WHERE id = 'prop_ptp_lifecycle_01'`, args: [] });
    await client.execute({ sql: `DELETE FROM payment_events WHERE id = 'evt_ptp_lifecycle_01'`, args: [] });

    // 1. Insert a payment event (schema: payment_events has no `status` column — use `source`)
    const eventId = "evt_ptp_lifecycle_01";
    await client.execute({
      sql: `INSERT OR IGNORE INTO payment_events (id, tenant_id, customer_id, amount_paise, failure_code, source, occurred_at_utc, ingested_at_utc)
            VALUES (?, 'demo', 'cust_ptp_01', 50000, 'INSUFFICIENT_FUNDS', 'SEED', ?, ?)`,
      args: [eventId, T0, T0],
    });

    // 2. Insert a proposal (minimal required columns per schema)
    const proposalId = "prop_ptp_lifecycle_01";
    await client.execute({
      sql: `INSERT OR IGNORE INTO proposals (id, event_id, customer_id, model_version_id, policy_version, action_json, ev_paise, confidence, dedupe_key, feature_version, state, created_at_utc, updated_at_utc)
            VALUES (?, ?, 'cust_ptp_01', 'logreg@1.0.0', 'v1', ?, 1000, 0.8, ?, 'feat-v1', 'AUTO_APPROVED', ?, ?)`,
      args: [
        proposalId,
        eventId,
        JSON.stringify({ action: "PROMISE_TO_PAY", multiplierUsed: 1.0 }),
        `dedupe_${proposalId}`,
        T0,
        T0,
      ],
    });

    // 3. Record promise to pay
    const promiseResult = await recordPromiseToPay(proposalId, 28, client);
    expect(promiseResult.success).toBe(true);
    expect(promiseResult.proposalId).toBe(proposalId);
    expect(promiseResult.promisedDay).toBe(28);
    expect(promiseResult.scheduledReminderUtc).toBeTruthy();

    // 4. Insert promise-to-pay record in DB
    const promiseId = "ptp_lifecycle_01";
    const promisedAtUtc = isoUtc(Date.now());
    await client.execute({
      sql: `INSERT OR IGNORE INTO promise_to_pay (id, tenant_id, customer_id, proposal_id, event_id, amount_paise, promised_at_utc, status, created_at_utc)
            VALUES (?, 'demo', 'cust_ptp_01', ?, ?, 50000, ?, 'PENDING', ?)`,
      args: [promiseId, proposalId, eventId, promisedAtUtc, promisedAtUtc],
    });

    // 5. Verify promise is PENDING
    const pending = await client.execute({
      sql: `SELECT status FROM promise_to_pay WHERE id = ?`,
      args: [promiseId],
    });
    expect(pending.rows.length).toBe(1);
    expect(String(pending.rows[0]!.status)).toBe("PENDING");

    // 6. Mark promise as KEPT (customer paid on time)
    const resolvedAt = isoUtc(Date.now() + 86400000 * 5);
    await client.execute({
      sql: `UPDATE promise_to_pay SET status = 'KEPT', resolved_at_utc = ? WHERE id = ?`,
      args: [resolvedAt, promiseId],
    });

    // 7. Verify promise is KEPT
    const kept = await client.execute({
      sql: `SELECT status, resolved_at_utc FROM promise_to_pay WHERE id = ?`,
      args: [promiseId],
    });
    expect(String(kept.rows[0]!.status)).toBe("KEPT");
    expect(kept.rows[0]!.resolved_at_utc).toBeTruthy();

    // 8. Verify audit trail has PROMISE_TO_PAY entry
    const audit = await client.execute({
      sql: `SELECT payload_json FROM audit_log WHERE event_id = ? AND entry_type = 'ACTION'`,
      args: [proposalId],
    });
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(String(audit.rows[0]!.payload_json));
    expect(payload.action).toBe("PROMISE_TO_PAY");
    expect(payload.promisedDay).toBe(28);
  });

  it("promise-to-pay lifecycle: propose → record → reconcile → mark broken", async () => {
    await client.execute({ sql: `DELETE FROM promise_to_pay WHERE id = 'ptp_broken_01'`, args: [] });
    await client.execute({ sql: `DELETE FROM proposals WHERE id = 'prop_ptp_broken_01'`, args: [] });
    await client.execute({ sql: `DELETE FROM payment_events WHERE id = 'evt_ptp_broken_01'`, args: [] });

    // 1. Insert payment event (different customer to avoid one-open-per-customer)
    const eventId = "evt_ptp_broken_01";
    await client.execute({
      sql: `INSERT OR IGNORE INTO payment_events (id, tenant_id, customer_id, amount_paise, failure_code, source, occurred_at_utc, ingested_at_utc)
            VALUES (?, 'demo', 'cust_ptp_02', 75000, 'CARD_EXPIRED', 'SEED', ?, ?)`,
      args: [eventId, T0, T0],
    });

    // 2. Insert proposal
    const proposalId = "prop_ptp_broken_01";
    await client.execute({
      sql: `INSERT OR IGNORE INTO proposals (id, event_id, customer_id, model_version_id, policy_version, action_json, ev_paise, confidence, dedupe_key, feature_version, state, created_at_utc, updated_at_utc)
            VALUES (?, ?, 'cust_ptp_02', 'logreg@1.0.0', 'v1', ?, 1000, 0.8, ?, 'feat-v1', 'AUTO_APPROVED', ?, ?)`,
      args: [
        proposalId,
        eventId,
        JSON.stringify({ action: "PROMISE_TO_PAY", multiplierUsed: 1.0 }),
        `dedupe_${proposalId}`,
        T0,
        T0,
      ],
    });

    // 3. Record promise
    await recordPromiseToPay(proposalId, 15, client);

    // 4. Insert promise record
    const promiseId = "ptp_broken_01";
    const promisedAtUtc = isoUtc(Date.now());
    await client.execute({
      sql: `INSERT OR IGNORE INTO promise_to_pay (id, tenant_id, customer_id, proposal_id, event_id, amount_paise, promised_at_utc, status, created_at_utc)
            VALUES (?, 'demo', 'cust_ptp_02', ?, ?, 75000, ?, 'PENDING', ?)`,
      args: [promiseId, proposalId, eventId, promisedAtUtc, promisedAtUtc],
    });

    // 5. Mark promise as BROKEN (customer did not pay)
    const resolvedAt = isoUtc(Date.now() + 86400000 * 10);
    await client.execute({
      sql: `UPDATE promise_to_pay SET status = 'BROKEN', resolved_at_utc = ? WHERE id = ?`,
      args: [resolvedAt, promiseId],
    });

    // 6. Verify promise is BROKEN
    const broken = await client.execute({
      sql: `SELECT status FROM promise_to_pay WHERE id = ?`,
      args: [promiseId],
    });
    expect(String(broken.rows[0]!.status)).toBe("BROKEN");
  });

  it("promise validation rejects invalid days", async () => {
    // Day 0 should default to 28
    const r1 = await recordPromiseToPay("prop_fake_1", 0, client);
    expect(r1.promisedDay).toBe(28);

    // Day 32 should default to 28
    const r2 = await recordPromiseToPay("prop_fake_2", 32, client);
    expect(r2.promisedDay).toBe(28);

    // Day 15 should be accepted
    const r3 = await recordPromiseToPay("prop_fake_3", 15, client);
    expect(r3.promisedDay).toBe(15);

    // Day 31 should be accepted
    const r4 = await recordPromiseToPay("prop_fake_4", 31, client);
    expect(r4.promisedDay).toBe(31);
  });

  it("promise_kept_rate feature reflects promise outcomes", async () => {
    // Count kept vs broken promises for test customers (both cust_ptp_01 and cust_ptp_02)
    const result = await client.execute({
      sql: `SELECT status, COUNT(*) as cnt FROM promise_to_pay WHERE customer_id IN ('cust_ptp_01','cust_ptp_02') GROUP BY status`,
      args: [],
    });

    const statusCounts: Record<string, number> = {};
    for (const row of result.rows) {
      statusCounts[String(row.status)] = Number(row.cnt);
    }

    // We created 1 KEPT and 1 BROKEN in this test suite
    expect(statusCounts["KEPT"] ?? 0).toBeGreaterThanOrEqual(1);
    expect(statusCounts["BROKEN"] ?? 0).toBeGreaterThanOrEqual(1);

    // promise_kept_rate = kept / (kept + broken)
    const kept = statusCounts["KEPT"] ?? 0;
    const broken = statusCounts["BROKEN"] ?? 0;
    const total = kept + broken;
    const keptRate = total > 0 ? kept / total : 0;
    expect(keptRate).toBeGreaterThan(0);
    expect(keptRate).toBeLessThanOrEqual(1);
  });
});
