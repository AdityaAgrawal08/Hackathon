import { describe, it, expect } from "vitest";
import {
  paise,
  formatINR,
  percentBp,
  rupeesToPaise,
  addP,
  subP,
  mulQty,
} from "../../packages/shared/src/money.js";
import { decide } from "../../packages/core/src/decide/engine.js";
import { defaultPolicy } from "../../packages/core/src/decide/policy.js";
import {
  renderComplianceMessage,
  type MessageTokenContext,
} from "../../packages/core/src/messaging/templates.js";
import {
  idempotencyKey,
  rzpRequestRef,
} from "../../packages/core/src/executor/index.js";

describe("Zero-Tolerance Payment Invariants Specification", () => {
  describe("Invariant 1: Integer Paise Money Math (Zero Floating-Point Corruptions)", () => {
    it("strictly refuses floating-point inputs in paise() constructor", () => {
      expect(() => paise(499.5)).toThrow(/requires an integer/);
      expect(() => paise(NaN)).toThrow(/requires an integer/);
      expect(() => paise(Infinity)).toThrow(/requires an integer/);
    });

    it("correctly converts floating rupees to integer paise via round-half-up", () => {
      expect(rupeesToPaise(19.99)).toBe(1999);
      expect(rupeesToPaise(0.01)).toBe(1);
      expect(rupeesToPaise(0.005)).toBe(1);
      expect(rupeesToPaise(499.0)).toBe(49900);
    });

    it("executes safe addition, subtraction, and basis-point operations", () => {
      const p1 = paise(199900); // ₹1,999.00
      const p2 = paise(150); // ₹1.50
      expect(subP(p1, p2)).toBe(199750); // ₹1,997.50
      expect(addP(p1, p2)).toBe(200050); // ₹2,000.50

      // 18% GST on ₹1,999.00 (1800 basis points)
      const gst = percentBp(p1, 1800);
      expect(gst).toBe(35982); // ₹359.82 exactly
    });

    it("formats Indian currency deterministically across lakhs and crores without ICU divergence", () => {
      expect(formatINR(paise(0))).toBe("₹0.00");
      expect(formatINR(paise(49900))).toBe("₹499.00");
      expect(formatINR(paise(199900))).toBe("₹1,999.00");
      expect(formatINR(paise(10000000))).toBe("₹1,00,000.00"); // 1 Lakh
      expect(formatINR(paise(1000000000))).toBe("₹1,00,00,000.00"); // 1 Crore
    });
  });

  describe("Invariant 2: Deterministic Idempotency Key & Provider Ref", () => {
    it("produces identical 16-hex idempotency keys for identical proposal and policy states", () => {
      const k1 = idempotencyKey("prop_001", "logreg@1.0.0", "policy-v1", '{"action":"RETRY_PAYDAY"}');
      const k2 = idempotencyKey("prop_001", "logreg@1.0.0", "policy-v1", '{"action":"RETRY_PAYDAY"}');
      expect(k1).toBe(k2);
      expect(k1.length).toBe(16);
    });

    it("produces deterministic, distinct rzpRequestRef for different actions", () => {
      const r1 = rzpRequestRef("prop_001", "RETRY_PAYDAY");
      const r2 = rzpRequestRef("prop_001", "ALTERNATE_UPI_LINK");
      expect(r1).not.toBe(r2);
      expect(r1.length).toBe(12);
    });
  });

  describe("Invariant 3: Regulatory & Conduct Stopping Rules", () => {
    const policy = defaultPolicy();

    it("enforces TRAI Quiet Hours (22:00 to 08:00 IST) — strictly refuses immediate customer contact", () => {
      // 17:00 UTC = 22:30 IST (Night-time)
      const nightMs = Date.parse("2026-08-28T17:00:00.000Z");
      const res = decide({
        probability: 0.8,
        failureClass: "SOFT_RETRYABLE",
        amountPaise: 199900,
        nowMs: nightMs,
        policy,
        attemptsSoFar: 0,
      });

      const quietRefusals = res.refusals.filter((r) => r.violatedRules.includes("QUIET_HOURS"));
      expect(quietRefusals.length).toBeGreaterThan(0);
    });

    it("enforces Attempt Caps (Max 2 contacts per billing cycle)", () => {
      const daytimeMs = Date.parse("2026-08-28T10:00:00.000Z"); // 15:30 IST
      const res = decide({
        probability: 0.8,
        failureClass: "SOFT_RETRYABLE",
        amountPaise: 199900,
        nowMs: daytimeMs,
        policy,
        attemptsSoFar: 2, // Max attempts reached
      });

      const capRefusals = res.refusals.filter((r) => r.violatedRules.includes("ATTEMPT_CAP"));
      expect(capRefusals.length).toBeGreaterThan(0);
    });

    it("strictly isolates RISK_FLAGGED to HUMAN_REVIEW (Zero customer spam / automated outreach)", () => {
      const daytimeMs = Date.parse("2026-08-28T10:00:00.000Z");
      const res = decide({
        probability: 0.9,
        failureClass: "RISK_FLAGGED",
        amountPaise: 5000000,
        nowMs: daytimeMs,
        policy,
        attemptsSoFar: 0,
      });

      expect(res.chosen.action).toBe("HUMAN_REVIEW");
    });
  });

  describe("Invariant 4: Data Privacy & Local Token Isolation (Zero PII to LLMs)", () => {
    it("renders DLT/Meta templates using strict local token replacement", () => {
      const ctx: MessageTokenContext = {
        customerName: "Aditya Agrawal",
        amountPaise: 499900,
        merchantName: "ARBITER Demo Store",
        instrumentDescription: "Visa ending in 8831",
        recoveryUrl: "https://pay.arbiter.in/r/tok_test123",
      };

      const msg = renderComplianceMessage("HARD_METHOD_DEAD", "WHATSAPP", "EN", ctx);
      expect(msg).not.toBeNull();
      expect(msg?.content).toContain("Aditya Agrawal");
      expect(msg?.content).toContain("₹4,999.00");
      expect(msg?.content).toContain("Visa ending in 8831");
      expect(msg?.content).toContain("https://pay.arbiter.in/r/tok_test123");
    });

    it("prohibits automated outreach templates for RISK_FLAGGED and UNKNOWN", () => {
      const ctx: MessageTokenContext = {
        customerName: "Suspect Bot",
        amountPaise: 5000000,
        merchantName: "ARBITER",
        instrumentDescription: "Virtual Card",
        recoveryUrl: "https://pay.arbiter.in/r/tok_bot",
      };

      expect(renderComplianceMessage("RISK_FLAGGED", "WHATSAPP", "EN", ctx)).toBeNull();
      expect(renderComplianceMessage("RISK_FLAGGED", "VOICE_IVR", "HI", ctx)).toBeNull();
      expect(renderComplianceMessage("UNKNOWN", "SMS", "EN", ctx)).toBeNull();
    });
  });
});
