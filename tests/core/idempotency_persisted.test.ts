import { describe, it, expect, beforeEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { LocalDeterministicGateway } from "../../packages/trial/src/gateway/local_deterministic.js";
import { createHash } from "node:crypto";
import { isoUtc } from "@arbiter/shared";

describe("Persisted Idempotency Barrier & Single-Settlement Invariants", () => {
  let client: Client;
  let gateway: LocalDeterministicGateway;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await runMigrations(client);
    gateway = new LocalDeterministicGateway(client);
  });

  it("produces exactly 1 local settlement for concurrent identical submissions", async () => {
    const tenantId = "demo";
    const clientIdemKey = "idem_concurrent_test_123";
    const amountPaise = 49900;
    const nowIso = isoUtc(Date.now());
    const payloadHash = createHash("sha256").update(JSON.stringify({ amountPaise })).digest("hex");
    const intentId = `pi_${clientIdemKey.slice(0, 16)}`;

    // 5 concurrent attempts
    const attempts = Array.from({ length: 5 }, (_, i) => ({
      id: `att_${i}_${clientIdemKey}`,
      attemptNumber: i + 1,
    }));

    // First attempt creates intent and settlement
    await client.batch(
      [
        {
          sql: `INSERT INTO payment_intents (id, client_idem_key, proposal_id, customer_id, tenant_id, amount_paise, status, client_visible, created_at_utc)
                VALUES (?, ?, 'prop_1', 'cust_1', ?, ?, 'SUCCEEDED', 'SUCCEEDED', ?)`,
          args: [intentId, clientIdemKey, tenantId, amountPaise, nowIso],
        },
        {
          sql: `INSERT INTO payment_attempts (id, payment_intent_id, tenant_id, client_idem_key, payload_hash, attempt_number, status, started_at_utc)
                VALUES (?, ?, ?, ?, ?, 1, 'SUCCEEDED', ?)`,
          args: [attempts[0]!.id, intentId, tenantId, clientIdemKey, payloadHash, nowIso],
        },
        {
          sql: `INSERT INTO local_settlements (id, payment_intent_id, idem_key, provider_payment_id, amount_paise, currency, settled_at_utc)
                VALUES (?, ?, ?, 'pay_123', ?, 'INR', ?)`,
          args: [`set_${intentId}`, intentId, clientIdemKey, amountPaise, nowIso],
        },
      ],
      "write",
    );

    // Replay with identical payload returns existing row
    const existing = await client.execute({
      sql: `SELECT * FROM payment_attempts WHERE tenant_id = ? AND client_idem_key = ?`,
      args: [tenantId, clientIdemKey],
    });
    expect(existing.rows.length).toBe(1);
    expect(existing.rows[0]!.payload_hash).toBe(payloadHash);

    // Verify exactly 1 settlement exists
    const settlements = await client.execute({
      sql: `SELECT * FROM local_settlements WHERE payment_intent_id = ?`,
      args: [intentId],
    });
    expect(settlements.rows.length).toBe(1);
  });

  it("detects and rejects payload mismatch on same idempotency key", async () => {
    const tenantId = "demo";
    const clientIdemKey = "idem_mismatch_test_456";
    const hashOriginal = createHash("sha256").update(JSON.stringify({ amountPaise: 49900 })).digest("hex");
    const hashModified = createHash("sha256").update(JSON.stringify({ amountPaise: 99900 })).digest("hex");
    const nowIso = isoUtc(Date.now());

    await client.execute({
      sql: `INSERT INTO payment_attempts (id, payment_intent_id, tenant_id, client_idem_key, payload_hash, attempt_number, status, started_at_utc)
            VALUES ('att_orig', 'pi_orig', ?, ?, ?, 1, 'SUCCEEDED', ?)`,
      args: [tenantId, clientIdemKey, hashOriginal, nowIso],
    });

    // Verify lookup discovers mismatch
    const r = await client.execute({
      sql: `SELECT payload_hash FROM payment_attempts WHERE tenant_id = ? AND client_idem_key = ?`,
      args: [tenantId, clientIdemKey],
    });

    expect(r.rows.length).toBe(1);
    expect(r.rows[0]!.payload_hash).toBe(hashOriginal);
    expect(r.rows[0]!.payload_hash !== hashModified).toBe(true);
  });
});
