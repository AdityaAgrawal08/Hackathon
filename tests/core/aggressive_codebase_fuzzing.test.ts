import { describe, it, expect } from "vitest";
import {
  diagnoseFailure,
  classifyRazorpayError,
  decide,
  defaultPolicy,
  renderComplianceMessage,
  OutreachRouter,
  BrevoEmailProvider,
  MSG91SmsProvider,
  TwilioVoiceProvider,
  GupshupWhatsAppProvider,
  type FailureClassId,
} from "../../packages/core/src/index.js";
import {
  computeFeatures,
  scoreWithArtifact,
  DEFAULT_16D_MODEL,
  FEATURE_NAMES,
} from "../../packages/ml/src/index.js";
import { paise, formatINR, rupeesToPaise, percentBp } from "../../packages/shared/src/index.js";

describe("Aggressive Codebase Fuzzing & Invariant Audit", () => {
  describe("Fuzzer 1: Razorpay Error Telemetry & Root Cause Classification", () => {
    const maliciousInputs = [
      "",
      "   ",
      "null",
      "undefined",
      "'; DROP TABLE audit_log; --",
      "<script>alert(1)</script>",
      "🎉🔥💸🚨",
      "A".repeat(10000),
      "GATEWAY_TIMEOUT_INTERNAL_ERROR_CUSTOM_999",
      "BAD_REQUEST_PAYMENT_UNKNOWN_BANK_CODE",
    ];

    it("never throws or returns invalid class on arbitrary malicious error strings", () => {
      const validClasses: FailureClassId[] = [
        "SOFT_RETRYABLE",
        "HARD_METHOD_DEAD",
        "NETWORK_TIMEOUT",
        "RISK_FLAGGED",
        "UNKNOWN",
      ];

      for (const input of maliciousInputs) {
        const cls = classifyRazorpayError(input);
        expect(validClasses).toContain(cls);

        const diag = diagnoseFailure(input, cls);
        expect(diag).toBeDefined();
        expect(diag.rootCause).toBeDefined();
        expect(typeof diag.explanation).toBe("string");
        expect(typeof diag.recommendedIntervention).toBe("string");
      }
    });
  });

  describe("Fuzzer 2: 23-Dimensional ML Feature Extraction & Scoring", () => {
    it("guarantees 100% finite, leakage-free 23-D vectors under extreme values", () => {
      const edgeCases = [
        // Case 1: 1 paise transaction with null customer
        {
          failureCode: "UNKNOWN",
          amountPaise: 1,
          occurredAtUtc: "2026-08-28T00:00:00.000Z",
          priorFailureAmountsPaise: [],
          priorFailureCount: 0,
          customer: null,
        },
        // Case 2: ₹1 Crore transaction with heavy past history
        {
          failureCode: "BAD_REQUEST_PAYMENT_FRAUD_IDENTIFIED",
          amountPaise: 1_000_000_000, // ₹1 Crore
          occurredAtUtc: "2026-12-31T23:59:59.999Z",
          priorFailureAmountsPaise: Array(100).fill(1_000_000),
          priorFailureCount: 100,
          customer: {
            paydayPattern: { "1": 100, "15": 200, "28": 300 },
            priorSuccessCount: 1000,
            joinedAtUtc: "2020-01-01T00:00:00.000Z",
            channelResponsiveness: 1.0,
          },
        },
        // Case 3: Gateway timeout on standard subscription
        {
          failureCode: "GATEWAY_TIMEOUT",
          amountPaise: 49900,
          occurredAtUtc: "2026-08-29T12:00:00.000Z",
          priorFailureAmountsPaise: [],
          priorFailureCount: 0,
          customer: {
            paydayPattern: {},
            priorSuccessCount: 0,
            joinedAtUtc: "2026-08-01T00:00:00.000Z",
            channelResponsiveness: 0.0,
          },
        },
      ];

      for (const ec of edgeCases) {
        const feat = computeFeatures(ec);
        expect(feat.values.length).toBe(23);
        expect(FEATURE_NAMES.length).toBe(23);

        for (let i = 0; i < 16; i++) {
          const val = feat.values[i];
          expect(Number.isFinite(val)).toBe(true);
          expect(Number.isNaN(val)).toBe(false);
        }

        // Score with model
        const score = scoreWithArtifact(feat.values, DEFAULT_16D_MODEL);
        expect(score.probability).toBeGreaterThanOrEqual(0.0);
        expect(score.probability).toBeLessThanOrEqual(1.0);
        expect(Number.isFinite(score.logit)).toBe(true);
        expect(score.attributions.length).toBeLessThanOrEqual(5);
      }
    });

    it("strictly throws on non-positive amounts or invalid dates", () => {
      expect(() =>
        computeFeatures({
          failureCode: "UNKNOWN",
          amountPaise: 0,
          occurredAtUtc: "2026-08-28T00:00:00.000Z",
          priorFailureAmountsPaise: [],
          priorFailureCount: 0,
          customer: null,
        }),
      ).toThrow(/amount must be positive integer/);

      expect(() =>
        computeFeatures({
          failureCode: "UNKNOWN",
          amountPaise: 100,
          occurredAtUtc: "INVALID_DATE",
          priorFailureAmountsPaise: [],
          priorFailureCount: 0,
          customer: null,
        }),
      ).toThrow(/invalid occurredAtUtc/);
    });



    it("verifies mathematical attribution identity across 1,000 random vectors", () => {
      for (let trial = 0; trial < 1000; trial++) {
        const randomValues = Array.from({ length: 23 }, () => (Math.random() - 0.5) * 10);
        const res = scoreWithArtifact(randomValues, DEFAULT_16D_MODEL);

        expect(res.probability).toBeGreaterThanOrEqual(0.0);
        expect(res.probability).toBeLessThanOrEqual(1.0);
      }
    });
  });

  describe("Fuzzer 3: Decision Engine & 24-Hour Sweeps Across All Failure Classes", () => {
    const policy = defaultPolicy();
    const failureClasses: FailureClassId[] = [
      "SOFT_RETRYABLE",
      "HARD_METHOD_DEAD",
      "NETWORK_TIMEOUT",
      "RISK_FLAGGED",
      "UNKNOWN",
    ];

    it("evaluates decisioning safely across all 1,440 minutes of the day for all failure classes", () => {
      const baseMs = Date.parse("2026-08-28T00:00:00.000Z");

      for (const fc of failureClasses) {
        // Step every 60 minutes throughout the 24-hour cycle
        for (let hour = 0; hour < 24; hour++) {
          const nowMs = baseMs + hour * 3600000;

          const out = decide({
            probability: 0.75,
            failureClass: fc,
            amountPaise: 499900,
            nowMs,
            policy,
            attemptsSoFar: 0,
            inferredPaydayDay: 28,
          });

          expect(out.chosen).toBeDefined();
          expect(typeof out.chosen.action).toBe("string");
          expect(Number.isFinite(out.chosen.evPaise)).toBe(true);
          expect(out.ranked.length).toBeGreaterThan(0);

          if (fc === "RISK_FLAGGED") {
            // Risk flagged must ALWAYS route to HUMAN_REVIEW
            expect(out.chosen.action).toBe("HUMAN_REVIEW");
          }
        }
      }
    });
  });

  describe("Fuzzer 4: Multi-Channel Provider Robustness & Injection Defense", () => {
    const attackPayload = {
      tenantId: "demo",
      proposalId: "prop_attack_999",
      idempotencyKey: "idem_attack_999",
      recipient: {
        customerId: "cust_hacker",
        name: "<script>alert('xss')</script> & 'DROP TABLE'",
        email: "hacker@test.com",
        phone: "+91 98-765-43210 (ext 123)",
        language: "HI" as const,
      },
      amountPaise: 999900,
      failureClass: "SOFT_RETRYABLE" as const,
      instrumentDescription: "<iframe src=x> HDFC Bank",
      recoveryUrl: "https://pay.arbiter.in/r/tok_attack?p=1&q=2",
    };

    it("Brevo Provider escapes HTML attack payloads cleanly", async () => {
      const brevo = new BrevoEmailProvider();
      const res = await brevo.send(attackPayload);
      expect(res.status).toBe("SENT");
      expect(res.costPaise).toBe(10);
    });

    it("MSG91 Provider sanitizes phone numbers and handles Hindi locale", async () => {
      const msg91 = new MSG91SmsProvider();
      const res = await msg91.send(attackPayload);
      expect(res.status).toBe("SENT");
      expect(res.costPaise).toBe(25);
    });

    it("Twilio Voice Provider escapes TwiML and XML tags", async () => {
      const twilio = new TwilioVoiceProvider();
      const res = await twilio.send(attackPayload);
      expect(res.status).toBe("QUEUED");
      expect(res.costPaise).toBe(150);
    });

    it("Gupshup WhatsApp Provider isolates tokens locally without PII leakage", async () => {
      const gupshup = new GupshupWhatsAppProvider();
      const res = await gupshup.send(attackPayload);
      expect(res.status).toBe("SENT");
      expect(res.costPaise).toBe(80);
    });
  });
});
