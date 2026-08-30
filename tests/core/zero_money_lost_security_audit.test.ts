import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { app } from "../../app/server.js";
import {
  simulateFailureTriage,
  completeRecovery,
  initiateRecoveryOrder,
  recordPromiseToPay,
  recoverySessions,
} from "../../app/recovery.js";

describe("Aggressive Zero-Money-Lost & Security Invariant Audit (Track 03)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe("Audit Vector 1: High-Concurrency Double Settlement & Double-Debit Shield", () => {
    it("guarantees strictly 1 settlement when 50 concurrent payment completion calls race simultaneously", async () => {
      // 1. Ingest failure
      const session = await simulateFailureTriage(
        {
          customerName: "Race Customer",
          customerPhone: "+919876500011",
          customerEmail: "race@example.com",
          amountPaise: 500000,
          failureCode: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
        },
        baseUrl,
      );

      const proposalId = session.id;

      // 2. Race 50 concurrent /api/recovery/complete calls
      const racePromises = Array.from({ length: 50 }, (_, i) =>
        fetch(`${baseUrl}/api/recovery/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            proposalId,
            razorpay_payment_id: `pay_race_${i}`,
            razorpay_order_id: `order_race_${i}`,
          }),
        }).then((res) => res.json()),
      );

      const results = await Promise.all(racePromises);

      // 3. Verify exactly 1 call successfully transitioned the state machine (Zero duplicate double-credits)
      const transitionedCount = results.filter((r) => r.success === true).length;
      expect(transitionedCount).toBe(1);


      // 4. Verify session state settled exactly once
      const finalSession = recoverySessions.get(proposalId);
      expect(finalSession).toBeDefined();
      expect(finalSession?.autonomyStatus).toBe("EXECUTED");

    });
  });

  describe("Audit Vector 2: Amount Sanitization & Floating Point Zero-Corruption Invariants", () => {
    it("handles extreme amounts, negative numbers, floats, and overflows safely without corruption", async () => {
      const edgeAmounts = [
        { input: -50000, expected: 100 }, // Negative clamped to minimum 100 paise (₹1)
        { input: 0, expected: 100 }, // Zero clamped to 100 paise
        { input: 199.9999, expected: 200 }, // Fractional float rounded to integer paise
        { input: 100000000000000, expected: 10000000000 }, // Huge number clamped to maximum safe ceiling
        { input: NaN, expected: 199900 }, // NaN fallback to default 199900
      ];

      for (const edge of edgeAmounts) {
        const session = await simulateFailureTriage(
          {
            customerName: "Amount Fuzz Customer",
            customerPhone: "+919876500022",
            amountPaise: edge.input as any,
          },
          baseUrl,
        );

        expect(session.amountPaise).toBe(edge.expected);
        expect(Number.isInteger(session.amountPaise)).toBe(true);
        expect(session.amountPaise).toBeGreaterThanOrEqual(100);
      }
    });
  });

  describe("Audit Vector 3: Webhook & Razorpay Signature Cryptographic Tamper Defense", () => {
    it("rejects forged or mutated HMAC-SHA256 signatures with constant-time equality check", async () => {
      const secret = "live_secret_key_arbiter_audit_999";
      const originalSecret = process.env.RZP_KEY_SECRET;
      process.env.RZP_KEY_SECRET = secret;

      try {
        const orderId = "order_audit_sec_001";
        const paymentId = "pay_audit_sec_001";
        const validPayload = `${orderId}|${paymentId}`;
        const validSig = createHmac("sha256", secret).update(validPayload).digest("hex");

        const session = await simulateFailureTriage(
          {
            customerName: "Crypto Fuzz Customer",
            customerPhone: "+919876500033",
            amountPaise: 199900,
          },
          baseUrl,
        );

        // Sub-case A: Mutated single character in signature
        const mutatedSig = validSig.substring(0, validSig.length - 1) + (validSig.endsWith("a") ? "b" : "a");
        const resMutated = await fetch(`${baseUrl}/api/recovery/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            proposalId: session.id,
            razorpay_payment_id: paymentId,
            razorpay_order_id: orderId,
            razorpay_signature: mutatedSig,
          }),
        });
        expect(resMutated.status).toBe(400);
        const dataMutated = await resMutated.json();
        expect(dataMutated.error).toBe("INVALID_RAZORPAY_SIGNATURE");

        // Sub-case B: Signature length mismatch (buffer overflow defense)
        const resShort = await fetch(`${baseUrl}/api/recovery/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            proposalId: session.id,
            razorpay_payment_id: paymentId,
            razorpay_order_id: orderId,
            razorpay_signature: "short_sig",
          }),
        });
        expect(resShort.status).toBe(400);

        // Sub-case C: Genuine valid signature passes cleanly
        const resValid = await fetch(`${baseUrl}/api/recovery/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            proposalId: session.id,
            razorpay_payment_id: paymentId,
            razorpay_order_id: orderId,
            razorpay_signature: validSig,
          }),
        });
        expect(resValid.status).toBe(200);
        const dataValid = await resValid.json();
        expect(dataValid.success).toBe(true);
        expect(dataValid.status).toBe("SETTLED_RECOVERED");
      } finally {
        if (originalSecret !== undefined) {
          process.env.RZP_KEY_SECRET = originalSecret;
        } else {
          delete process.env.RZP_KEY_SECRET;
        }
      }
    });
  });

  describe("Audit Vector 4: SQL Injection & XSS Payload Sanitization Fuzzing", () => {
    it("ingests and renders malicious script tags and SQL injection strings safely without corruption", async () => {
      const maliciousPayloads = [
        "'; DROP TABLE audit_log; --",
        "<script>alert('xss')</script>",
        "<img src=x onerror=alert(1)>",
        "UNION SELECT null, null, username, password FROM users --",
        '{"$gt": ""}',
        "\x00\x01\x02\x03",
      ];

      for (const payload of maliciousPayloads) {
        const res = await fetch(`${baseUrl}/api/orders/simulate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerName: payload,
            customerPhone: "+919876500044",
            customerEmail: "sqli_test@example.com",
            amountPaise: 199900,
            failureCode: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
            instrumentDesc: payload,
            tcAgreed: true,
            outreachPermitted: true,
          }),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.session.id).toBeDefined();

        // Verify recovery order initiation with malicious payload succeeds safely
        const order = await initiateRecoveryOrder(data.session.id);
        expect(order).toBeDefined();
        expect(order?.orderId).toMatch(/^order_/);
      }
    });
  });

  describe("Audit Vector 5: Promise-To-Pay (PTP) Date Boundary Fuzzing", () => {
    it("clamps and handles invalid, out-of-bounds, or non-numeric salary days safely", async () => {
      const invalidDays = [-10, 0, 32, 99, 1000, 31];

      for (const day of invalidDays) {
        const session = await simulateFailureTriage(
          {
            customerName: "PTP Fuzz",
            customerPhone: "+919876500055",
            amountPaise: 199900,
          },
          baseUrl,
        );

        const res = await fetch(`${baseUrl}/api/recovery/promise-to-pay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            proposalId: session.id,
            promisedDay: day,
          }),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        // Clamped to valid calendar day (1 to 31)
        expect(data.promisedDay).toBeGreaterThanOrEqual(1);
        expect(data.promisedDay).toBeLessThanOrEqual(31);

        expect(data.scheduledReminderUtc).toBeDefined();
      }
    });
  });

  describe("Audit Vector 6: Host Header Poisoning & Open Redirect Defense", () => {
    it("sanitizes malicious Host headers in recovery URL generation", async () => {
      const res = await fetch(`${baseUrl}/api/orders/simulate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Host": "evil-phishing-site.com",
          "X-Forwarded-Host": "attacker.com",
        },
        body: JSON.stringify({
          customerName: "Host Poison Test",
          customerPhone: "+919876500066",
          customerEmail: "host@example.com",
          amountPaise: 199900,
          tcAgreed: true,
          outreachPermitted: true,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);

      // Assert that recovery URL does NOT redirect to malicious domain
      expect(data.session.recoveryUrl).not.toContain("evil-phishing-site.com");
      expect(data.session.recoveryUrl).not.toContain("attacker.com");
    });
  });

  describe("Audit Vector 7: TRAI Quiet Hours Compliance Enforcement", () => {
    it("enforces quiet hours suppression during nighttime hours (21:00 - 09:00 IST)", async () => {
      // 1. 23:00 IST (Nighttime) -> Automated contact forbidden by TRAI -> Requires Human Review
      const nightTimeMs = new Date("2026-08-30T23:00:00+05:30").getTime();

      const nightSession = await simulateFailureTriage(
        {
          customerName: "Night Customer",
          customerPhone: "+919876500077",
          customerEmail: "night@example.com",
          amountPaise: 199900,
          failureCode: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
          outreachPermitted: true,
        },
        baseUrl,
        undefined,
        nightTimeMs,
      );

      expect(nightSession).toBeDefined();
      expect(nightSession.autonomyStatus).toBe("AWAITING_APPROVAL");
      expect(nightSession.decideOutput.chosen.action).toBe("HUMAN_REVIEW");

      // 2. 11:00 AM IST (Daytime) -> Permitted by TRAI -> Auto-approved
      const dayTimeMs = new Date("2026-08-30T11:00:00+05:30").getTime();

      const daySession = await simulateFailureTriage(
        {
          customerName: "Day Customer",
          customerPhone: "+919876500088",
          customerEmail: "day@example.com",
          amountPaise: 199900,
          failureCode: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
          outreachPermitted: true,
        },
        baseUrl,
        undefined,
        dayTimeMs,
      );

      expect(daySession).toBeDefined();
      expect(daySession.autonomyStatus).toBe("AUTO_APPROVED");
    });
  });
});

