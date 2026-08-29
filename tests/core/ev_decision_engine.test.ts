import { describe, it, expect } from "vitest";
import { decide } from "../../packages/core/src/decide/engine.js";
import { defaultPolicy } from "../../packages/core/src/decide/policy.js";

describe("Expected Value & Policy Decision Engine (Task 1.3 & 1.5)", () => {
  const policy = defaultPolicy();

  it("selects RETRY_PAYDAY for SOFT_RETRYABLE when payday is inferred and within budget", () => {
    // 2026-08-28 10:00 AM UTC -> 15:30 IST (not quiet hours)
    const nowMs = Date.parse("2026-08-28T10:00:00.000Z");
    const res = decide({
      probability: 0.7,
      failureClass: "SOFT_RETRYABLE",
      amountPaise: 49900, // ₹499
      nowMs,
      policy,
      inferredPaydayDay: 28,
      attemptsSoFar: 0,
    });

    expect(res.chosen.action).toBe("RETRY_PAYDAY");
    expect(res.chosen.evPaise).toBeGreaterThan(0);
    expect(res.refusals.length).toBe(0);
  });

  it("selects ALTERNATE_UPI_LINK or RECOVER_VIA_RAIL for HARD_METHOD_DEAD (dead retry = 0 mult)", () => {
    const nowMs = Date.parse("2026-08-28T10:00:00.000Z");
    const res = decide({
      probability: 0.6,
      failureClass: "HARD_METHOD_DEAD",
      amountPaise: 199900, // ₹1,999
      nowMs,
      policy,
      attemptsSoFar: 0,
    });

    // RETRY_NOW and RETRY_PAYDAY have 0 multiplier for HARD_METHOD_DEAD, so they violate CONFIDENCE_FLOOR
    const retryNowRefusal = res.refusals.find((r) => r.action === "RETRY_NOW");
    expect(retryNowRefusal?.violatedRules).toContain("CONFIDENCE_FLOOR");

    // Chosen action should be an alternate rail / link
    expect(["RECOVER_VIA_RAIL", "ALTERNATE_UPI_LINK", "PARTIAL_COLLECT"]).toContain(
      res.chosen.action,
    );

  });

  it("enforces quiet hours (22:00 to 08:00 IST) by refusing contact actions", () => {
    // 2026-08-28 17:30 UTC -> 23:00 IST (Quiet hours active)
    const nightMs = Date.parse("2026-08-28T17:30:00.000Z");
    const res = decide({
      probability: 0.7,
      failureClass: "HARD_METHOD_DEAD",
      amountPaise: 199900,
      nowMs: nightMs,
      policy,
      attemptsSoFar: 0,
    });

    // Contact actions must be refused with QUIET_HOURS
    const quietRefusals = res.refusals.filter((r) =>
      r.violatedRules.includes("QUIET_HOURS"),
    );
    expect(quietRefusals.length).toBeGreaterThan(0);
  });

  it("enforces attempt cap (max 2) by refusing contact actions on attempt 2+", () => {
    const nowMs = Date.parse("2026-08-28T10:00:00.000Z");
    const res = decide({
      probability: 0.7,
      failureClass: "SOFT_RETRYABLE",
      amountPaise: 49900,
      nowMs,
      policy,
      attemptsSoFar: 2, // At maximum cap
    });

    const capRefusals = res.refusals.filter((r) =>
      r.violatedRules.includes("ATTEMPT_CAP"),
    );
    expect(capRefusals.length).toBeGreaterThan(0);
  });

  it("routes RISK_FLAGGED failures exclusively to HUMAN_REVIEW with 0 customer contact", () => {
    const nowMs = Date.parse("2026-08-28T10:00:00.000Z");
    const res = decide({
      probability: 0.9,
      failureClass: "RISK_FLAGGED",
      amountPaise: 500000,
      nowMs,
      policy,
      attemptsSoFar: 0,
    });

    expect(res.chosen.action).toBe("HUMAN_REVIEW");
  });
});
