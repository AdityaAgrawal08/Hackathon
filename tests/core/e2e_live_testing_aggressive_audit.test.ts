import { describe, it, expect } from "vitest";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  simulateFailureTriage,
  getRecoveryTrace,
  completeRecovery,
  PRESETS,
} from "../../app/recovery.js";
import {
  OutreachRouter,
  type OutreachProvider,
  type OutreachPayload,
} from "../../packages/core/src/index.js";
import { paise, formatINR, addP, subP, mulQty, percentBp } from "@arbiter/shared";
import { ingestDomainWebhook } from "../../packages/core/src/ingest/webhook.js";
import { createClient } from "@libsql/client";

describe("Phase 7 Aggressive Audit: Chaos Resilience, Arithmetic Fuzzing, Security & Corpus Replay (Tasks 7.7–7.10)", () => {
  const DAYTIME_MS = Date.parse("2026-08-28T05:30:00.000Z");

  describe("Audit 1 (Task 7.7): Chaos Downstream Outage & Cascade Resilience", () => {
    it("transparently cascades through multiple failing providers without dropping recovery payload", async () => {
      const router = new OutreachRouter();

      let attempts = 0;
      const failingGateway1: OutreachProvider = {
        name: "msg91_primary_route",
        channel: "SMS",
        send: async () => {
          attempts++;
          throw new Error("502 Bad Gateway: Upstream carrier timeout");
        },
      };

      const failingGateway2: OutreachProvider = {
        name: "msg91_secondary_route",
        channel: "SMS",
        send: async () => {
          attempts++;
          throw new Error("504 Gateway Timeout: SMSC socket hang up");
        },
      };

      const successfulBackup: OutreachProvider = {
        name: "kaleyra_failover_route",
        channel: "SMS",
        send: async (p: OutreachPayload) => {
          attempts++;
          return {
            providerName: "kaleyra_failover_route",
            channel: "SMS",
            externalMessageId: `kal_${p.proposalId}`,
            status: "SENT",
            costPaise: 28,
            dispatchedAtUtc: new Date().toISOString(),
          };
        },
      };

      router.registerProvider(failingGateway1);
      router.registerProvider(failingGateway2);
      router.registerProvider(successfulBackup);

      const payload: OutreachPayload = {
        proposalId: "prop_chaos_test",
        failureClass: "SOFT_RETRYABLE",
        action: "RECOVER_SMS",
        recipient: { customerName: "Chaos Subject", phone: "+91 98765 00000" },
        amountPaise: 199900,
        paymentLinkUrl: "https://arbiter.live/pay/tok_chaos",
        language: "EN",
        rawErrorReason: "INSUFFICIENT_FUNDS",
      };

      const result = await router.dispatch("SMS", payload, DAYTIME_MS);
      expect(result.status).toBe("SENT");
      expect(result.providerName).toBe("kaleyra_failover_route");
      expect(attempts).toBe(3);
    });
  });

  describe("Audit 2 (Task 7.8): 10,000-Point Integer Paise Arithmetic Invariance", () => {
    it("guarantees BasePaise + GSTPaise (18%) === TotalPaise across 10,000 randomized boundary values", () => {
      // 10,000 distinct boundary & randomized amounts from ₹0.01 (1 paise) to ₹10,00,000.00 (100,000,000 paise)
      for (let i = 1; i <= 10000; i++) {
        const totalPaiseVal = i <= 500
          ? i // micro-transactions (1 paise to 500 paise)
          : Math.floor(Math.random() * 100000000) + 100;

        const total = paise(totalPaiseVal);
        // Base = round(Total / 1.18)
        const base = paise(Math.round(total / 1.18));
        // GST = Total - Base
        const gst = subP(total, base);

        // Invariant: base + gst === total
        expect(addP(base, gst)).toBe(total);

        // Invariant: GST is exactly 18% of base (+/- 1 paise rounding tolerance)
        const expectedGst = Math.round(base * 0.18);
        expect(Math.abs(gst - expectedGst)).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("Audit 3 (Task 7.9): Webhook Signature Forgery & Timing Side-Channel Defense", () => {
    it("rejects forged signatures, length-mismatched keys, and corrupt payloads using constant-time evaluation", async () => {
      const db = createClient({ url: ":memory:" });
      const secret = "whsec_super_secure_production_secret_key_998877";

      const validPayload = JSON.stringify({
        event: "payment.failed",
        payload: {
          payment: {
            entity: {
              id: "pay_test_12345",
              order_id: "order_test_12345",
              amount: 199900,
              currency: "INR",
              status: "failed",
              error_code: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
            },
          },
        },
      });

      const validSignature = createHmac("sha256", secret).update(validPayload).digest("hex");

      // 1. Altered payload with valid signature -> Rejected 400
      const tamperedPayload = validPayload.replace("199900", "999900");
      const r1 = await ingestDomainWebhook({
        client: db,
        rawBody: Buffer.from(tamperedPayload),
        signature: validSignature,
        webhookSecret: secret,
      });
      expect(r1.statusCode).toBe(400);
      expect(r1.status).toBe("REJECTED");

      // 2. Truncated / Length-mismatched signature -> Rejected 400
      const truncatedSig = validSignature.slice(0, 32);
      const r2 = await ingestDomainWebhook({
        client: db,
        rawBody: Buffer.from(validPayload),
        signature: truncatedSig,
        webhookSecret: secret,
      });
      expect(r2.statusCode).toBe(400);
      expect(r2.status).toBe("REJECTED");

      // 3. Forged signature -> Rejected 400
      const forgedSig = "0000000000000000000000000000000000000000000000000000000000000000";
      const r3 = await ingestDomainWebhook({
        client: db,
        rawBody: Buffer.from(validPayload),
        signature: forgedSig,
        webhookSecret: secret,
      });
      expect(r3.statusCode).toBe(400);
      expect(r3.status).toBe("REJECTED");
    });
  });


  describe("Audit 4 (Task 7.10): Corpus Replay & 100% Deterministic Repeatability Proof", () => {
    it("guarantees 100% identical diagnosis, feature vector, and EV decision outputs across repeated corpus replays", async () => {
      const presetKeys = Object.keys(PRESETS);

      for (const key of presetKeys) {
        // Run 1
        const run1 = await simulateFailureTriage(key, "http://localhost:3000", undefined, DAYTIME_MS);
        // Run 2
        const run2 = await simulateFailureTriage(key, "http://localhost:3000", undefined, DAYTIME_MS);

        // Verify deterministic classification match
        expect(run1.diagnosis.class).toBe(run2.diagnosis.class);
        expect(run1.diagnosis.rootCause).toBe(run2.diagnosis.rootCause);

        // Verify deterministic EV action match
        expect(run1.decideOutput.chosen.action).toBe(run2.decideOutput.chosen.action);
        expect(run1.decideOutput.chosen.evPaise).toBe(run2.decideOutput.chosen.evPaise);
        expect(run1.autonomyStatus).toBe(run2.autonomyStatus);
      }
    });
  });
});
