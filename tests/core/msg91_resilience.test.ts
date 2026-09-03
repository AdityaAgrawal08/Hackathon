/**
 * Automated Tests for Task 6.6 / MSG-07: MSG91 Phone Normalizer & Resilience
 */
import { describe, it, expect } from "vitest";
import { normalizeIndianPhone, MSG91SmsProvider } from "../../packages/core/src/messaging/providers/msg91.js";

describe("Task 6.6 / MSG-07: MSG91 Phone Normalizer & Gateway Resilience", () => {
  describe("1. Indian Phone Normalization", () => {
    it("normalizes clean 10-digit mobile number to 91XXXXXXXXXX", () => {
      expect(normalizeIndianPhone("9876543210")).toBe("919876543210");
    });

    it("strips country prefix '+91', spaces, and formatting characters", () => {
      expect(normalizeIndianPhone("+91 98765 43210")).toBe("919876543210");
      expect(normalizeIndianPhone("+91-98765-43210")).toBe("919876543210");
      expect(normalizeIndianPhone("(+91) 9876543210")).toBe("919876543210");
    });

    it("strips trunk prefix '0' from 11-digit mobile numbers", () => {
      expect(normalizeIndianPhone("09876543210")).toBe("919876543210");
    });

    it("preserves already canonical 12-digit numbers starting with 91", () => {
      expect(normalizeIndianPhone("919876543210")).toBe("919876543210");
    });
  });

  describe("2. Gateway Resilience & Fallback", () => {
    it("safely enters simulated mode when authKey or templateId are absent", async () => {
      const provider = new MSG91SmsProvider({ authKey: undefined, templateId: undefined });

      const result = await provider.send({
        proposalId: "prop_resilience_1",
        recipient: { phone: "+91 98765 43210", name: "Ananya Roy" },
        channel: "SMS",
        amountPaise: 299900,
        failureClass: "SOFT_RETRYABLE",
        recoveryUrl: "https://arbiter.live/pay/tok_test",
      });

      expect(result.status).toBe("SENT");
      expect(result.costPaise).toBe(0);
      expect((result.rawResponse as any).phone).toBe("919876543210");
      expect(result.errorMessage).toContain("SIMULATED");
    });
  });
});
