/**
 * §4.3 Regulatory / compliance auto-escalation (RBI / NPCI / DPDP / TRAI).
 *  - regulatory_profile lives in the fail-closed policy constraint engine
 *  - CONSENT_LAPSED (DPDP 2023): no consent ⇒ no contact recovery at all
 *  - AUTOPAY_RETRY_CEILING (NPCI 1+3): cap debit attempts per mandate
 *  - PRE_DEBIT_NOTICE (NPCI): immediate RETRY_NOW on an autopay mandate is refused
 *  - these are HARD refusals; merchant autonomy cannot override them
 */
import { describe, it, expect } from "vitest";
import {
  defaultPolicy,
  parsePolicyPack,
  type PolicyPack,
  type RuleId,
} from "../../packages/core/src/decide/policy.js";
import { decide } from "../../packages/core/src/decide/engine.js";

const NOW = Date.UTC(2026, 1, 15, 10, 0, 0); // 15:30 IST

function policyWith(reg: Partial<PolicyPack["regulatory_profile"]>): PolicyPack {
  const p = defaultPolicy();
  return { ...p, regulatory_profile: { ...p.regulatory_profile, ...reg } };
}

describe("regulatory_profile is part of the fail-closed policy pack", () => {
  it("default policy carries a valid regulatory profile and parses strictly", () => {
    expect(() => parsePolicyPack(defaultPolicy())).not.toThrow();
    const p = defaultPolicy();
    expect(p.regulatory_profile.jurisdiction).toBe("IN");
    expect(p.regulatory_profile.autopay_retry_ceiling).toBe(3);
  });
});

describe("DPDP 2023 — CONSENT_LAPSED", () => {
  const policy = policyWith({ dpdp_consent_status: "LAPSED" });
  it("refuses ALL contact recovery actions when consent lapsed", () => {
    const out = decide({
      probability: 0.8,
      failureClass: "SOFT_RETRYABLE",
      amountPaise: 49_900,
      nowMs: NOW,
      policy,
    });
    for (const a of ["RETRY_NOW", "RETRY_PAYDAY", "ALTERNATE_UPI_LINK", "RECOVER_VIA_RAIL", "RECOVER_VOICE_HI", "RECOVER_WHATSAPP", "REMINDER_LINK"]) {
      const refused = out.refusals.find((r) => r.action === a);
      expect(refused?.violatedRules).toContain("CONSENT_LAPSED" as RuleId);
    }
    // Only NO_ACTION survives (no PI processing required).
    expect(out.ranked.map((r) => r.action)).toEqual(["NO_ACTION"]);
  });
  it("NOT_GIVEN consent is also refused (fail-closed on missing consent)", () => {
    const policy2 = policyWith({ dpdp_consent_status: "NOT_GIVEN" });
    const out = decide({ probability: 0.8, failureClass: "SOFT_RETRYABLE", amountPaise: 49_900, nowMs: NOW, policy: policy2 });
    expect(out.refusals.find((r) => r.action === "RETRY_NOW")?.violatedRules).toContain("CONSENT_LAPSED");
  });
});

describe("NPCI 1+3 — AUTOPAY_RETRY_CEILING", () => {
  const policy = policyWith({ mandate_type: "UPI_AUTOPAY", autopay_retry_ceiling: 3 });
  it("refuses autopay retries once attempts hit the ceiling", () => {
    const out = decide({
      probability: 0.8,
      failureClass: "SOFT_RETRYABLE",
      amountPaise: 49_900,
      nowMs: NOW,
      policy,
      attemptsSoFar: 3,
    });
    for (const a of ["RETRY_NOW", "RETRY_PAYDAY", "RECOVER_VIA_RAIL"]) {
      const refused = out.refusals.find((r) => r.action === a);
      expect(refused?.violatedRules).toContain("AUTOPAY_RETRY_CEILING" as RuleId);
    }
  });
  it("allows retries below the ceiling", () => {
    const out = decide({
      probability: 0.8,
      failureClass: "SOFT_RETRYABLE",
      amountPaise: 49_900,
      nowMs: NOW,
      policy,
      attemptsSoFar: 1,
    });
    const refused = out.refusals.find((r) => r.action === "RETRY_NOW");
    expect(refused?.violatedRules).not.toContain("AUTOPAY_RETRY_CEILING");
  });
});

describe("NPCI pre-debit notice — PRE_DEBIT_NOTICE", () => {
  const policy = policyWith({ mandate_type: "UPI_AUTOPAY", pre_debit_notice_hours: 24 });
  it("refuses an immediate RETRY_NOW on an autopay mandate (no advance notice)", () => {
    const out = decide({
      probability: 0.8,
      failureClass: "SOFT_RETRYABLE",
      amountPaise: 49_900,
      nowMs: NOW,
      policy,
    });
    const refused = out.refusals.find((r) => r.action === "RETRY_NOW");
    expect(refused?.violatedRules).toContain("PRE_DEBIT_NOTICE" as RuleId);
  });
  it("allows a SCHEDULED retry (RETRY_PAYDAY) — it carries the mandated notice", () => {
    const out = decide({
      probability: 0.8,
      failureClass: "SOFT_RETRYABLE",
      amountPaise: 49_900,
      nowMs: NOW,
      policy,
      inferredPaydayDay: 25,
    });
    const refused = out.refusals.find((r) => r.action === "RETRY_PAYDAY");
    expect(refused?.violatedRules ?? []).not.toContain("PRE_DEBIT_NOTICE");
  });
});

describe("merchant autonomy cannot override regulatory refusals (fail-closed)", () => {
  it("CONSENT_LAPSED still refuses even though the autonomy envelope would allow the channel", () => {
    // The point: the regulatory rule lives in the policy constraint engine,
    // independent of the merchant envelope, so it cannot be toggled off.
    const policy = policyWith({ dpdp_consent_status: "LAPSED" });
    const out = decide({
      probability: 0.9,
      failureClass: "SOFT_RETRYABLE",
      amountPaise: 49_900,
      nowMs: NOW,
      policy,
    });
    expect(out.refusals.some((r) => r.violatedRules.includes("CONSENT_LAPSED" as RuleId))).toBe(true);
  });
});
