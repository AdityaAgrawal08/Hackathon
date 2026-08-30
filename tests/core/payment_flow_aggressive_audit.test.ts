import { describe, it, expect, beforeAll } from "vitest";
import {
  initiateRecoveryOrder,
  recordPromiseToPay,
  completeRecovery,
  simulateFailureTriage,
  recoverySessions,
  liveMetrics,
} from "../../app/recovery.js";

describe("Aggressive Audit: Interactive Payment Flow & Financial Invariants", () => {
  let sampleProposalId = "";

  beforeAll(async () => {
    // 11:00 AM IST daytime
    const DAYTIME_MS = Date.parse("2026-08-28T05:30:00.000Z");
    const session = await simulateFailureTriage("SALARY_DELAY", "http://localhost:3000", undefined, DAYTIME_MS);
    sampleProposalId = session.id;
  });

  describe("Audit 1: Recovery Order Initiation Fuzzing", () => {
    it("handles non-existent and malicious token lookups without throwing", async () => {
      const maliciousTokens = [
        "",
        "   ",
        "'; DROP TABLE audit_log; --",
        "<script>alert(1)</script>",
        "tok_non_existent_9999",
      ];

      for (const tok of maliciousTokens) {
        const order = await initiateRecoveryOrder(tok);
        if (order) {
          // Should fallback to valid active session or return null safely
          expect(order.orderId).toMatch(/^order_/);
          expect(order.amountPaise).toBeGreaterThan(0);

          expect(order.currency).toBe("INR");
          expect(order.qrDataUrl).toMatch(/^data:image\/png;base64,/);
          expect(order.upiIntentUrl).toContain("upi://pay");
        }
      }
    });
  });

  describe("Audit 2: Promise-To-Pay Validation & Day Clamping", () => {
    it("strictly clamps and validates promisedDay to integers in range [1, 31]", async () => {
      const testCases = [
        { input: -5, expected: 28 },
        { input: 0, expected: 28 },
        { input: 32, expected: 28 },
        { input: 999, expected: 28 },
        { input: 1, expected: 1 },
        { input: 15, expected: 15 },
        { input: 31, expected: 31 },
      ];

      for (const tc of testCases) {
        const res = await recordPromiseToPay(sampleProposalId, tc.input);
        expect(res.success).toBe(true);
        expect(res.promisedDay).toBe(tc.expected);
        expect(Number.isInteger(res.promisedDay)).toBe(true);
      }
    });
  });

  describe("Audit 3: Idempotent Settlement & Double-Credit Prevention", () => {
    it("guarantees single settlement even when completeRecovery is invoked 10 times concurrently", async () => {
      const initialRecovered = liveMetrics.totalRecoveredPaise;
      const session = recoverySessions.get(sampleProposalId);
      expect(session).toBeDefined();

      const amount = session!.amountPaise;

      // Invoke completeRecovery 10 times in parallel
      const results = await Promise.all(
        Array.from({ length: 10 }, () => completeRecovery(sampleProposalId)),
      );

      // Exactly 1 must have returned true (transitioned), all others returned false (idempotent no-op)
      const trueCount = results.filter(Boolean).length;
      expect(trueCount).toBe(1);

      // Financial balance increased by EXACTLY one amount (Zero double-credit)
      expect(liveMetrics.totalRecoveredPaise).toBe(initialRecovered + amount);
    });
  });
});
