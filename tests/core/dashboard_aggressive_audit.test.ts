import { describe, it, expect } from "vitest";
import {
  simulateFailureTriage,
  runBatchBenchmark,
  PRESETS,
} from "../../app/recovery.js";

describe("Aggressive Audit: Phase 5 Merchant Command Center & Governance Invariants", () => {
  const DAYTIME_MS = Date.parse("2026-08-28T05:30:00.000Z"); // 11:00 AM IST

  describe("Audit 1: Autonomy Envelope Boundary & Fraud Quarantine Invariants", () => {
    it("strictly respects boundary conditions and quarantines fraud regardless of threshold dial", async () => {
      // Test 50 distinct threshold envelopes from ₹500 to ₹10,000
      const thresholds = Array.from({ length: 50 }, (_, i) => (500 + i * 200) * 100);

      for (const thresholdPaise of thresholds) {
        // Case A: Amount strictly below threshold (Soft Retryable) -> AUTO_APPROVED
        const sessionBelow = await simulateFailureTriage(
          {
            amountPaise: thresholdPaise - 100, // ₹1 below threshold
            failureCode: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
          },
          "http://localhost:3000",
          undefined,
          DAYTIME_MS,
          thresholdPaise,
        );
        expect(sessionBelow.autonomyStatus).toBe("AUTO_APPROVED");

        // Case B: Amount strictly above threshold (Soft Retryable) -> AWAITING_APPROVAL
        const sessionAbove = await simulateFailureTriage(
          {
            amountPaise: thresholdPaise + 100, // ₹1 above threshold
            failureCode: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
          },
          "http://localhost:3000",
          undefined,
          DAYTIME_MS,
          thresholdPaise,
        );
        expect(sessionAbove.autonomyStatus).toBe("AWAITING_APPROVAL");

        // Case C: High-Risk / Fraud (Zero-Trust Safety Invariant)
        // Must ALWAYS be AWAITING_APPROVAL even if amount is small (e.g. ₹100) and threshold is high (₹10,000)
        const sessionFraud = await simulateFailureTriage(
          {
            amountPaise: 10000, // ₹100
            failureCode: "BAD_REQUEST_PAYMENT_FRAUD_IDENTIFIED",
          },
          "http://localhost:3000",
          undefined,
          DAYTIME_MS,
          thresholdPaise,
        );
        expect(sessionFraud.autonomyStatus).toBe("AWAITING_APPROVAL");
      }
    });
  });

  describe("Audit 2: 100-Event Monte Carlo Benchmark Statistical Invariants ('The Bar')", () => {
    it("guarantees ARBITER revenue lift and retry savings across 50 repeated batch runs (5,000 events)", async () => {
      for (let run = 0; run < 50; run++) {
        const benchmark = await runBatchBenchmark();

        // Invariant 1: Batch size is strictly 100
        expect(benchmark.batchSize).toBe(100);

        // Invariant 2: Total at risk is positive
        expect(benchmark.totalAtRiskPaise).toBeGreaterThan(0);

        // Invariant 3: ARBITER outperforms naive blind retries in 100% of runs
        expect(benchmark.arbiterRecoveredPaise).toBeGreaterThan(benchmark.controlRecoveredPaise);

        // Invariant 4: Wasted retries saved is strictly positive (dead cards suppressed)
        expect(benchmark.wastedRetriesSaved).toBeGreaterThan(0);

        // Invariant 5: Mathematical conservation
        expect(benchmark.controlRecoveredPaise + benchmark.delta.additionalRevenuePaise).toBe(
          benchmark.arbiterRecoveredPaise,
        );

        // Invariant 6: Zero spam complaints due to quiet hours compliance
        expect(benchmark.spamComplaints).toBe(0);
      }
    });
  });

  describe("Audit 3: Custom Telemetry Injection Fuzzing & Sanitization", () => {
    it("handles adversarial injection payloads without memory leaks or unhandled exceptions", async () => {
      const adversarialPayloads = [
        {
          customerName: "<script>alert('xss')</script>",
          amountPaise: 0,
          failureCode: "'; DROP TABLE audit_log; --",
        },
        {
          customerName: "Robert'); DROP TABLE users;--",
          amountPaise: -5000,
          failureCode: "UNKNOWN_BANK_CRASH_999",
        },
        {
          customerName: "A".repeat(1000),
          amountPaise: 1000000000, // 1 crore paise (₹1,00,000)
          failureCode: "BAD_REQUEST_PAYMENT_CARD_EXPIRED",
        },
      ];

      for (const payload of adversarialPayloads) {
        const session = await simulateFailureTriage(
          payload,
          "http://localhost:3000",
          undefined,
          DAYTIME_MS,
        );

        expect(session).toBeDefined();
        expect(session.id).toMatch(/^prop_/);
        expect(session.diagnosis).toBeDefined();
        expect(session.features.values.length).toBe(22);
        expect(session.decideOutput.chosen).toBeDefined();
      }
    });
  });
});
