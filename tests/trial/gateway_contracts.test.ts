import { describe, it, expect, beforeEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import {
  LocalDeterministicGateway,
  LOCAL_FAULT_PROFILES,
} from "../../packages/trial/src/gateway/local_deterministic.js";
import { RazorpayLiveGateway } from "../../packages/trial/src/gateway/razorpay_live.js";

describe("Gateway Contract Fidelity & Deterministic Fault Profiles", () => {
  let client: Client;
  let localGateway: LocalDeterministicGateway;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await runMigrations(client);
    localGateway = new LocalDeterministicGateway(client);
  });

  it("verifies all 9 LOCAL_SANDBOX fault profiles execute deterministically", async () => {
    expect(LOCAL_FAULT_PROFILES.length).toBe(9);

    for (const profile of LOCAL_FAULT_PROFILES) {
      const order = await localGateway.createOrder({
        tenantId: "demo",
        amountPaise: 49900,
        receipt: `rcpt_${profile}`,
      });
      expect(order.id).toContain("order_local_");

      const chargeRes = await localGateway.charge({
        tenantId: "demo",
        orderId: order.id,
        clientIdemKey: `idem_${profile}`,
        amountPaise: 49900,
        scenario: profile,
      });

      if (profile === "LOCAL_SUCCESS" || profile === "LOCAL_DUPLICATE_SUBMIT") {
        expect(chargeRes.status).toBe("succeeded");
      } else if (profile === "LOCAL_GATEWAY_TIMEOUT" || profile === "LOCAL_LOST_RESPONSE") {
        expect(chargeRes.status).toBe("transport_dropped");
      } else {
        expect(chargeRes.status).toBe("failed");
        expect(chargeRes.errorCode).toBe(profile);
      }
    }
  });

  it("persists simulated provider state durably in SQLite across lookups", async () => {
    const order = await localGateway.createOrder({
      tenantId: "demo",
      amountPaise: 49900,
      receipt: "rcpt_durable_test",
    });

    const chargeRes = await localGateway.charge({
      tenantId: "demo",
      orderId: order.id,
      clientIdemKey: "idem_durable_lookup_1",
      amountPaise: 49900,
      scenario: "LOCAL_SUCCESS",
    });

    // Lookup via fetchPayment
    const status = await localGateway.fetchPayment(chargeRes.providerPaymentId);
    expect(status).not.toBeNull();
    expect(status!.status).toBe("captured");
    expect(status!.amountPaise).toBe(49900);
    expect(status!.providerOrderId).toBe(order.id);
  });

  it("validates RazorpayLiveGateway fails closed if environment variables are missing", () => {
    delete process.env.RZP_TEST_KEY_ID;
    delete process.env.RZP_TEST_KEY_SECRET;

    expect(() => new RazorpayLiveGateway()).toThrow(
      /Missing RZP_TEST_KEY_ID or RZP_TEST_KEY_SECRET/,
    );
  });
});
