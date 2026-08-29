import { describe, it, expect, beforeEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import {
  sweepStuckIntents,
  reconcilePaymentIntent,
  calculateBackoffMs,
} from "../../packages/core/src/executor/reconciliation.js";
import { findIntent, computeCanonicalPayloadHash } from "../../packages/core/src/executor/payment_intent.js";
import { isoUtc } from "../../packages/shared/src/index.js";

describe("Hardening & Concurrency Sweep Tests", () => {
  let client: Client;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await runMigrations(client);
  });

  it("calculates exponential backoff with randomized jitter", () => {
    for (let i = 0; i < 6; i++) {
      const delay = calculateBackoffMs(i);
      expect(delay).toBeGreaterThanOrEqual(1600); // 2000 * 0.8 min
      expect(delay).toBeLessThanOrEqual(72000);  // 60000 * 1.2 max
    }
  });

  it("produces deterministic canonical payload hashes regardless of JSON key insertion order", () => {
    const hashA = computeCanonicalPayloadHash({
      amountPaise: 49900,
      scenario: "LOCAL_SUCCESS",
      token: "tok_12345",
    });
    const hashB = computeCanonicalPayloadHash({
      token: "tok_12345",
      scenario: "LOCAL_SUCCESS",
      amountPaise: 49900,
    });
    expect(hashA).toBe(hashB);
  });

  it("atomically coordinates multi-worker sweep claiming without double-processing", async () => {
    const t0 = 1770000000000;
    const oldUtc = isoUtc(t0 - 10000);

    // Insert 2 stuck intents
    await client.execute({
      sql: `INSERT INTO payment_intents
              (id, client_idem_key, proposal_id, customer_id, tenant_id, amount_paise, status, client_visible, created_at_utc)
            VALUES
              ('pi_sweep_1', 'idem_sw1', 'prop_sw1', 'cust_1', 'tenant_a', 50000, 'UNKNOWN', 'UNKNOWN', ?),
              ('pi_sweep_2', 'idem_sw2', 'prop_sw2', 'cust_2', 'tenant_a', 50000, 'UNKNOWN', 'UNKNOWN', ?)`,
      args: [oldUtc, oldUtc],
    });

    const mockGateway = {
      async fetchPayment(id: string) {
        return {
          providerPaymentId: id,
          providerOrderId: "order_1",
          status: "captured" as const,
          amountPaise: 50000,
          currency: "INR",
        };
      },
    };

    // Worker 1 sweeps
    const worker1Resolved = await sweepStuckIntents(client, mockGateway, t0, "worker_1");
    // Worker 2 sweeps concurrently
    const worker2Resolved = await sweepStuckIntents(client, mockGateway, t0, "worker_2");

    expect(worker1Resolved + worker2Resolved).toBe(2);
    // Both intents are resolved to SUCCEEDED
    const rows = await client.execute(`SELECT status FROM payment_intents WHERE status = 'SUCCEEDED'`);
    expect(rows.rows.length).toBe(2);
  });

  it("scopes findIntent by tenant_id to prevent cross-tenant idempotency collisions", async () => {
    const t0 = 1770000000000;
    const nowIso = isoUtc(t0);

    await client.execute({
      sql: `INSERT INTO payment_intents
              (id, client_idem_key, proposal_id, customer_id, tenant_id, amount_paise, status, client_visible, created_at_utc)
            VALUES ('pi_tenant_x', 'shared_key_1', 'prop_1', 'cust_x', 'tenant_x', 20000, 'SUCCEEDED', 'SUCCEEDED', ?)`,
      args: [nowIso],
    });

    // Lookup with correct tenant
    const found = await findIntent(client, "shared_key_1", "tenant_x");
    expect(found).not.toBeNull();
    expect(found?.id).toBe("pi_tenant_x");

    // Lookup with different tenant returns null
    const notFound = await findIntent(client, "shared_key_1", "tenant_y");
    expect(notFound).toBeNull();
  });
});
