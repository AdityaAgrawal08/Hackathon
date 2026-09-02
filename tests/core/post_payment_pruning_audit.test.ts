import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import {
  appendAuditLedger,
  getAuditLedgerForEntity,
  verifyAuditLedgerChain,
  computeEntryHash,
} from "../../packages/core/src/ledger/audit_ledger.js";
import { onPaymentRecovered, createPromiseToPay } from "../../app/payment_workflow.js";

describe("Post-Payment Pruning & Cryptographic Audit Ledger (PRUNE-02 & AUDIT-01)", () => {
  let client: Client;
  const testCustomerId = "cust_prune_audit_test";
  const testEventId = "evt_prune_audit_test";
  const testOrderId = "order_prune_audit_test";

  beforeAll(async () => {
    client = createClient({ url: ":memory:" });
    await runMigrations(client);

    const nowUtc = new Date().toISOString();

    // 1. Seed Customer
    await client.execute({
      sql: `INSERT INTO customer_profiles (id, name, phone, email, created_at_utc)
            VALUES (?, 'Pooja Nair', '+919876500000', 'pooja@example.test', ?)`,
      args: [testCustomerId, nowUtc],
    });

    // 2. Seed Failed Event
    await client.execute({
      sql: `INSERT INTO live_payment_events (id, customer_profile_id, product_name, amount_paise, status, created_at_utc)
            VALUES (?, ?, 'Team License', 199900, 'failed', ?)`,
      args: [testEventId, testCustomerId, nowUtc],
    });

    // 3. Seed Multiple Scheduled Reminders
    await client.execute({
      sql: `INSERT INTO scheduled_outreach (id, live_payment_event_id, customer_profile_id, channel, scheduled_at_utc, status, executed)
            VALUES ('sch_1', ?, ?, 'SMS', ?, 'PENDING', 0),
                   ('sch_2', ?, ?, 'EMAIL', ?, 'PENDING', 0),
                   ('sch_3', ?, ?, 'SMS', ?, 'PENDING', 0)`,
      args: [testEventId, testCustomerId, nowUtc, testEventId, testCustomerId, nowUtc, testEventId, testCustomerId, nowUtc],
    });
  });

  it("appends sequential entries and maintains valid cryptographic SHA-256 chain", async () => {
    const entry1 = await appendAuditLedger(client, {
      eventType: "EVENT_DETECTED",
      entityId: testOrderId,
      customerId: testCustomerId,
      payload: { amountPaise: 199900 },
    });

    expect(entry1.prevHash).toBe("GENESIS");
    expect(entry1.entryHash).toMatch(/^[a-f0-9]{64}$/);

    const entry2 = await appendAuditLedger(client, {
      eventType: "OUTREACH_DISPATCHED",
      entityId: testOrderId,
      customerId: testCustomerId,
      payload: { channel: "SMS", provider: "msg91" },
    });

    expect(entry2.prevHash).toBe(entry1.entryHash);
    expect(entry2.entryHash).toMatch(/^[a-f0-9]{64}$/);

    const verification = await verifyAuditLedgerChain(client);
    expect(verification.valid).toBe(true);
    expect(verification.totalEntries).toBeGreaterThanOrEqual(2);
  });

  it("detects tampering when an entry hash or payload is modified", async () => {
    // Insert a forged entry with invalid hash
    await client.execute({
      sql: `INSERT INTO audit_ledger (id, event_type, entity_id, customer_id, actor, payload_json, prev_hash, entry_hash, created_at_utc)
            VALUES ('aud_forged', 'ILLEGAL_ALTER', 'fake_entity', 'fake_cust', 'hacker', '{"tampered":true}', 'GENESIS', 'bad_hash_123', ?)`,
      args: [new Date().toISOString()],
    });

    const verification = await verifyAuditLedgerChain(client);
    expect(verification.valid).toBe(false);
  });

  it("onPaymentRecovered cleanly cancels 100% of pending scheduled dunning reminders", async () => {
    // Reset DB state for clean check
    const isolatedClient = createClient({ url: ":memory:" });
    await runMigrations(isolatedClient);
    const nowUtc = new Date().toISOString();

    await isolatedClient.execute({
      sql: `INSERT INTO customer_profiles (id, name, phone, email, created_at_utc)
            VALUES (?, 'Test User', '+919999999999', 'test@example.com', ?)`,
      args: [testCustomerId, nowUtc],
    });
    await isolatedClient.execute({
      sql: `INSERT INTO live_payment_events (id, customer_profile_id, product_name, amount_paise, status, created_at_utc)
            VALUES (?, ?, 'Product X', 100000, 'failed', ?)`,
      args: [testEventId, testCustomerId, nowUtc],
    });
    await isolatedClient.execute({
      sql: `INSERT INTO scheduled_outreach (id, live_payment_event_id, customer_profile_id, channel, scheduled_at_utc, status, executed)
            VALUES ('s1', ?, ?, 'SMS', ?, 'PENDING', 0),
                   ('s2', ?, ?, 'EMAIL', ?, 'PENDING', 0)`,
      args: [testEventId, testCustomerId, nowUtc, testEventId, testCustomerId, nowUtc],
    });

    const result = await onPaymentRecovered(isolatedClient, {
      customerProfileId: testCustomerId,
      orderId: testOrderId,
      eventId: testEventId,
      amountPaise: 100000,
    });

    expect(result.recovered).toBe(true);
    expect(result.cancelledOutreachCount).toBe(2);

    const remainingPending = await isolatedClient.execute({
      sql: `SELECT count(*) as count FROM scheduled_outreach WHERE customer_profile_id = ? AND status = 'PENDING'`,
      args: [testCustomerId],
    });
    expect(Number(remainingPending.rows[0].count)).toBe(0);

    const auditChain = await getAuditLedgerForEntity(isolatedClient, testOrderId);
    expect(auditChain.length).toBeGreaterThan(0);
    expect(auditChain[0].eventType).toBe("RECOVERY_COMPLETED");
  });
});
