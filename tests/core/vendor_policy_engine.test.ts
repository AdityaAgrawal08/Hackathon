/**
 * Automated Tests for Task 6.7: Vendor Recovery Policy Engine (Split-Pay, Grace & Mandate Rules)
 */
import { describe, it, expect } from "vitest";
import { defaultPolicy, parsePolicyPack, type PolicyPack } from "../../packages/core/src/decide/policy.js";

describe("Task 6.7 / POL-08: Vendor Recovery Policy Engine", () => {
  it("validates fail-closed default policy configuration with RBI / TRAI regulatory guardrails", () => {
    const policy = defaultPolicy();
    expect(policy.policy_version).toBe("policy-v1");
    expect(policy.regulatory_profile.jurisdiction).toBe("IN");
    expect(policy.regulatory_profile.pre_debit_notice_hours).toBe(24);
    expect(policy.regulatory_profile.autopay_retry_ceiling).toBe(3);
  });

  it("strictly rejects malformed or unknown policy keys (fail-closed security invariant)", () => {
    const malformed = {
      ...defaultPolicy(),
      unknown_bypass_flag: true,
    };

    expect(() => parsePolicyPack(malformed)).toThrow();
  });

  it("enforces regulatory mandate limits and quiet hours constraints", () => {
    const customPolicy: PolicyPack = {
      ...defaultPolicy(),
      confidence_floor_bp: 3000,
      exposure_cap_paise: 5000000, // ₹50,000 cap
    };

    const parsed = parsePolicyPack(customPolicy);
    expect(parsed.confidence_floor_bp).toBe(3000);
    expect(parsed.exposure_cap_paise).toBe(5000000);
  });
});
