import { describe, it, expect } from "vitest";
import { decideRuleBased, isNearPayday } from "../../packages/core/src/decide/rules_baseline.js";

describe("Deterministic 7-Rule Heuristic Baseline (RULE-01)", () => {
  // Daytime timestamp: 14:00 IST = 08:30 UTC
  const DAYTIME_MS = new Date("2026-09-02T08:30:00.000Z").getTime();
  // Nighttime timestamp: 23:00 IST = 17:30 UTC
  const NIGHTTIME_MS = new Date("2026-09-02T17:30:00.000Z").getTime();

  it("Rule 1: TRAI Quiet Hours Guard (21:00-09:00 IST) suppresses outreach", () => {
    const decision = decideRuleBased({
      failureClass: "SOFT_RETRYABLE",
      nowMs: NIGHTTIME_MS,
      customerPayday: 28,
      attemptsSoFar: 0,
    });

    expect(decision.action).toBe("HUMAN_REVIEW");
    expect(decision.isContactAction).toBe(false);
    expect(decision.deferredDueToQuietHours).toBe(true);
    expect(decision.rationale).toContain("quiet hours");
  });

  it("Rule 2: Max attempts cap (>=2) escalates to human review", () => {
    const decision = decideRuleBased({
      failureClass: "SOFT_RETRYABLE",
      nowMs: DAYTIME_MS,
      customerPayday: 28,
      attemptsSoFar: 2,
    });

    expect(decision.action).toBe("HUMAN_REVIEW");
    expect(decision.isContactAction).toBe(false);
    expect(decision.rationale).toContain("exhausted");
  });

  it("Rule 3: Minimum contact interval (<24h) yields NO_ACTION", () => {
    const decision = decideRuleBased({
      failureClass: "SOFT_RETRYABLE",
      nowMs: DAYTIME_MS,
      customerPayday: 28,
      attemptsSoFar: 0,
      lastContactAtMs: DAYTIME_MS - 2 * 3600 * 1000, // 2 hours ago
    });

    expect(decision.action).toBe("NO_ACTION");
    expect(decision.isContactAction).toBe(false);
  });

  it("Rule 4: HARD_METHOD_DEAD routes to ALTERNATE_UPI_LINK", () => {
    const decision = decideRuleBased({
      failureClass: "HARD_METHOD_DEAD",
      nowMs: DAYTIME_MS,
      customerPayday: 28,
      attemptsSoFar: 0,
    });

    expect(decision.action).toBe("ALTERNATE_UPI_LINK");
    expect(decision.isContactAction).toBe(true);
    expect(decision.rationale).toContain("alternate UPI link");
  });

  it("Rule 5a: SOFT_RETRYABLE near payday (±2 days) routes to RETRY_NOW", () => {
    // 2nd day of month with payday on 1st -> diff is 1 <= 2 -> near payday
    const decision = decideRuleBased({
      failureClass: "SOFT_RETRYABLE",
      nowMs: DAYTIME_MS, // Sept 2
      customerPayday: 1,
      attemptsSoFar: 0,
    });

    expect(decision.action).toBe("RETRY_NOW");
    expect(decision.isContactAction).toBe(true);
    expect(decision.rationale).toContain("near payday");
  });

  it("Rule 5b: SOFT_RETRYABLE mid-month routes to RETRY_PAYDAY", () => {
    // Sept 2 with payday on 28th -> diff is 26 -> not near payday
    const decision = decideRuleBased({
      failureClass: "SOFT_RETRYABLE",
      nowMs: DAYTIME_MS,
      customerPayday: 28,
      attemptsSoFar: 0,
    });

    expect(decision.action).toBe("RETRY_PAYDAY");
    expect(decision.isContactAction).toBe(true);
    expect(decision.rationale).toContain("salary date");
  });

  it("Rule 6: NETWORK_TIMEOUT routes to RETRY_NOW", () => {
    const decision = decideRuleBased({
      failureClass: "NETWORK_TIMEOUT",
      nowMs: DAYTIME_MS,
      attemptsSoFar: 0,
    });

    expect(decision.action).toBe("RETRY_NOW");
    expect(decision.isContactAction).toBe(true);
  });

  it("Rule 7: RISK_FLAGGED strictly escalates to HUMAN_REVIEW", () => {
    const decision = decideRuleBased({
      failureClass: "RISK_FLAGGED",
      nowMs: DAYTIME_MS,
      attemptsSoFar: 0,
    });

    expect(decision.action).toBe("HUMAN_REVIEW");
    expect(decision.isContactAction).toBe(false);
    expect(decision.rationale).toContain("Risk/fraud alert");
  });

  it("Default Rule: UNKNOWN routes to REMINDER_LINK", () => {
    const decision = decideRuleBased({
      failureClass: "UNKNOWN",
      nowMs: DAYTIME_MS,
      attemptsSoFar: 0,
    });

    expect(decision.action).toBe("REMINDER_LINK");
    expect(decision.isContactAction).toBe(true);
  });

  it("isNearPayday handles month wraparound correctly", () => {
    // Sept 2 (day 2), payday 31 -> diff 29 -> 31-29 = 2 -> near payday
    expect(isNearPayday(31, DAYTIME_MS)).toBe(true);
    // Sept 2 (day 2), payday 15 -> diff 13 -> not near payday
    expect(isNearPayday(15, DAYTIME_MS)).toBe(false);
    // null or invalid
    expect(isNearPayday(null, DAYTIME_MS)).toBe(false);
    expect(isNearPayday(undefined, DAYTIME_MS)).toBe(false);
  });
});
