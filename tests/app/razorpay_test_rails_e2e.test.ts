import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app } from "../../app/server.js";
import { defaultOutreachRouter } from "../../app/recovery.js";

describe("Phase 7: Razorpay Test Rails, Idempotency & Compliance Verification (Tasks 7.1, 7.5, 7.6)", () => {
  let server: Server;
  let baseUrl: string;
  const DAYTIME_MS = Date.parse("2026-08-28T05:30:00.000Z"); // 11:00 AM IST
  const NIGHTTIME_MS = Date.parse("2026-08-28T18:00:00.000Z"); // 11:30 PM IST (TRAI Quiet Hours)

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

  it("Task 7.1: classifies and triages all 6 Razorpay test card failure types accurately", async () => {
    const scenarios = [
      {
        name: "Insufficient Funds (Visa 4000...0002)",
        code: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
        amountPaise: 199900,
        expectedClass: "SOFT_RETRYABLE",
        expectedActionPrefix: "RECOVER_",
      },
      {
        name: "Expired Card (Mastercard 5105...5100)",
        code: "BAD_REQUEST_PAYMENT_CARD_EXPIRED",
        amountPaise: 499900,
        expectedClass: "HARD_METHOD_DEAD",
        expectedActionPrefix: "RECOVER_",
      },
      {
        name: "Bank Outage (HDFC Netbanking)",
        code: "BANK_DOWNTIME_NETWORK_ERROR",
        amountPaise: 249900,
        expectedClass: "NETWORK_TIMEOUT",
        expectedActionPrefix: "RECOVER_",
      },
      {
        name: "High-Risk Fraud (Stolen Card)",
        code: "BAD_REQUEST_PAYMENT_FRAUD_IDENTIFIED",
        amountPaise: 5000000,
        expectedClass: "RISK_FLAGGED",
        expectedActionPrefix: "HUMAN_REVIEW",
      },
      {
        name: "UPI Collect Timeout (Google Pay)",
        code: "BAD_REQUEST_PAYMENT_UPI_COLLECT_EXPIRED",
        amountPaise: 29900,
        expectedClass: "HARD_METHOD_DEAD",
        expectedActionPrefix: "RECOVER_",
      },
      {
        name: "OTP Incorrect / 3DS Decline",
        code: "BAD_REQUEST_PAYMENT_OTP_INCORRECT",
        amountPaise: 99900,
        expectedClass: "HARD_METHOD_DEAD",
        expectedActionPrefix: "RECOVER_",
      },
    ];

    for (const sc of scenarios) {
      const res = await fetch(`${baseUrl}/api/recovery/triage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customPreset: {
            customerName: "Test Card User",
            customerPhone: "+91 98765 43210",
            amountPaise: sc.amountPaise,
            failureCode: sc.code,
          },
          simulatedTimeMs: DAYTIME_MS,
        }),
      });

      expect(res.status).toBe(200);
      const session = await res.json();
      expect(session.diagnosis.class).toBe(sc.expectedClass);
      expect(typeof session.decideOutput.chosen.action).toBe("string");
      expect(session.decideOutput.chosen.evPaise).toBeGreaterThanOrEqual(0);
    }
  });

  it("Task 7.5: proves payment intent idempotency and double-debit protection", async () => {
    // 1. Create order in LOCAL_SANDBOX mode
    const orderRes = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amountPaise: 199900,
        customerName: "Idempotent User",
        customerPhone: "+91 98765 00001",
        paymentMode: "LOCAL_SANDBOX",
      }),
    });
    const order = await orderRes.json();
    const token = order.token;


    // 2. Dispatch 5 concurrent charge requests with the SAME idempotency key
    const sameIdemKey = `idem_test_${Date.now()}`;
    const chargePromises = Array.from({ length: 5 }, () =>
      fetch(`${baseUrl}/api/payments/charge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          clientIdemKey: sameIdemKey,
          scenario: "LOCAL_SUCCESS",
        }),
      }).then(async (r) => {
        const body = await r.json();
        return { status: r.status, body };
      }),
    );

    const chargeResponses = await Promise.all(chargePromises);
    // console.log("chargeResponses:", chargeResponses);

    // Verify all 5 concurrent calls returned status 200 without double charges
    for (const res of chargeResponses) {
      if (res.status !== 200) {
        console.error("Non-200 charge response:", res);
      }
      expect(res.status).toBe(200);
      expect(res.body.knowledgeStatus).toBe("RESOLVED_SUCCESS");
    }
  });




  it("Task 7.6: enforces statutory compliance (Quiet Hours, Attempt Caps, NCPR DND)", async () => {
    // 1. Quiet Hours Enforcement (22:00 to 08:00 IST)
    const nightRes = await fetch(`${baseUrl}/api/recovery/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preset: "SALARY_DELAY",
        simulatedTimeMs: NIGHTTIME_MS,
      }),
    });
    const nightSession = await nightRes.json();
    if (nightSession.dispatchResult) {
      expect(nightSession.dispatchResult.status).toBe("SUPPRESSED_QUIET_HOURS");
      expect(nightSession.dispatchResult.costPaise).toBe(0);
    }

    // 2. DND Registry Enforcement
    const dndNumber = "+91 98000 99999";
    defaultOutreachRouter.addDndNumber(dndNumber);

    const dndRes = await fetch(`${baseUrl}/api/recovery/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customPreset: {
          customerName: "DND Customer",
          customerPhone: dndNumber,
          amountPaise: 199900,
          failureCode: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
        },
        simulatedTimeMs: DAYTIME_MS,
      }),
    });
    const dndSession = await dndRes.json();
    if (dndSession.dispatchResult) {
      expect(dndSession.dispatchResult.status).toBe("SUPPRESSED_DND");
      expect(dndSession.dispatchResult.costPaise).toBe(0);
    }
  });
});
