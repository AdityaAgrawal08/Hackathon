import { describe, it, expect, beforeEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { LocalDeterministicGateway } from "../../packages/trial/src/gateway/local_deterministic.js";
import {
  reconcilePaymentIntent,
  sweepStuckIntents,
  MAX_RECONCILIATION_DURATION_MS,
} from "../../packages/core/src/executor/reconciliation.js";
import { isoUtc } from "@arbiter/shared";

describe("Two-Way Reconciliation & Race Condition Invariants", () => {
  let client: Client;
  let gateway: LocalDeterministicGateway;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await runMigrations(client);
    gateway = new LocalDeterministicGateway(client);
  });

  it("resolves lost-response hazard via status API reconciliation without double settlement", async () => {
    const tenantId = "demo";
    const clientIdemKey = "idem_lost_resp_123";
    const amountPaise = 49900;
    const nowMs = Date.now();
    const nowIso = isoUtc(nowMs);
    const intentId = "pi_lost_resp_123";
    const orderId = "order_local_lost_123";

    // 1. Charge with LOCAL_LOST_RESPONSE
    const chargeRes = await gateway.charge({
      tenantId,
      orderId,
      clientIdemKey,
      amountPaise,
      scenario: "LOCAL_LOST_RESPONSE",
    });
    expect(chargeRes.status).toBe("transport_dropped");

    // 2. Client records UNRESOLVED_UNKNOWN
    await client.batch(
      [
        {
          sql: `INSERT INTO payment_intents (id, client_idem_key, proposal_id, customer_id, tenant_id, amount_paise, status, client_visible, scenario, created_at_utc)
                VALUES (?, ?, 'prop_1', 'cust_1', ?, ?, 'UNKNOWN', 'UNKNOWN', 'LOCAL_LOST_RESPONSE', ?)`,
          args: [intentId, clientIdemKey, tenantId, amountPaise, nowIso],
        },
        {
          sql: `INSERT INTO payment_attempts (id, payment_intent_id, tenant_id, client_idem_key, payload_hash, attempt_number, status, provider_payment_id, started_at_utc)
                VALUES ('att_1', ?, ?, ?, 'hash_1', 1, 'UNKNOWN', ?, ?)`,
          args: [intentId, tenantId, clientIdemKey, chargeRes.providerPaymentId, nowIso],
        },
      ],
      "write",
    );

    // 3. Sweeper runs reconciliation
    const reconRes = await reconcilePaymentIntent(client, gateway, intentId, nowMs + 3000);
    expect(reconRes.resolved).toBe(true);
    expect(reconRes.knowledgeStatus).toBe("RESOLVED_SUCCESS");

    // 4. Verify exactly 1 LocalSettlement exists
    const settlements = await client.execute({
      sql: `SELECT * FROM local_settlements WHERE payment_intent_id = ?`,
      args: [intentId],
    });
    expect(settlements.rows.length).toBe(1);
    expect(settlements.rows[0]!.amount_paise).toBe(amountPaise);
  });

  it("never assumes FAILED when 5-minute reconciliation TTL expires", async () => {
    const tenantId = "demo";
    const clientIdemKey = "idem_stalled_123";
    const intentId = "pi_stalled_123";
    const tOld = Date.now() - (MAX_RECONCILIATION_DURATION_MS + 10000); // 5m 10s ago

    // Intent created 5+ minutes ago with no provider status available
    await client.execute({
      sql: `INSERT INTO payment_intents (id, client_idem_key, proposal_id, customer_id, tenant_id, amount_paise, status, client_visible, created_at_utc)
            VALUES (?, ?, 'prop_stalled', 'cust_1', ?, 49900, 'UNKNOWN', 'UNKNOWN', ?)`,
      args: [intentId, clientIdemKey, tenantId, isoUtc(tOld)],
    });

    const reconRes = await reconcilePaymentIntent(client, gateway, intentId, Date.now());

    // Must be RECONCILIATION_EXHAUSTED and remain UNRESOLVED_UNKNOWN
    expect(reconRes.resolved).toBe(false);
    expect(reconRes.reconciliationState).toBe("RECONCILIATION_EXHAUSTED");
    expect(reconRes.knowledgeStatus).toBe("UNRESOLVED_UNKNOWN");

    // Must NOT have transitioned intent status to FAILED in DB!
    const pi = await client.execute({
      sql: `SELECT status, client_visible FROM payment_intents WHERE id = ?`,
      args: [intentId],
    });
    expect(pi.rows[0]!.status).toBe("UNKNOWN");
    expect(pi.rows[0]!.client_visible).toBe("UNKNOWN");

    // Must have logged alarm in audit_log
    const audits = await client.execute({
      sql: `SELECT * FROM audit_log WHERE event_id = ?`,
      args: [intentId],
    });
    expect(audits.rows.length).toBeGreaterThan(0);
    expect(String(audits.rows[0]!.payload_json)).toContain("RECONCILIATION_EXHAUSTED");
  });
});
