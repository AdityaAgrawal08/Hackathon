import { describe, it, expect } from "vitest";
import { isQuietHoursIST, IST_OFFSET_MS } from "../../packages/core/src/decide/window.js";
import { defaultPolicy, evaluateConstraints, type ConstraintContext } from "../../packages/core/src/decide/policy.js";

describe("TRAI Quiet Hours IST Evaluation (TRAI-06)", () => {
  it("correctly identifies 21:00 to 09:00 IST as quiet hours", () => {
    // 21:30 IST = 16:00 UTC
    const date2130IST = new Date("2026-09-02T16:00:00.000Z").getTime();
    expect(isQuietHoursIST(date2130IST)).toBe(true);

    // 23:00 IST = 17:30 UTC
    const date2300IST = new Date("2026-09-02T17:30:00.000Z").getTime();
    expect(isQuietHoursIST(date2300IST)).toBe(true);

    // 03:00 IST = 21:30 UTC (prev day)
    const date0300IST = new Date("2026-09-01T21:30:00.000Z").getTime();
    expect(isQuietHoursIST(date0300IST)).toBe(true);

    // 08:59 IST = 03:29 UTC
    const date0859IST = new Date("2026-09-02T03:29:00.000Z").getTime();
    expect(isQuietHoursIST(date0859IST)).toBe(true);
  });

  it("correctly identifies daytime (09:00 to 21:00 IST) as active hours", () => {
    // 09:00 IST = 03:30 UTC
    const date0900IST = new Date("2026-09-02T03:30:00.000Z").getTime();
    expect(isQuietHoursIST(date0900IST)).toBe(false);

    // 14:00 IST = 08:30 UTC
    const date1400IST = new Date("2026-09-02T08:30:00.000Z").getTime();
    expect(isQuietHoursIST(date1400IST)).toBe(false);

    // 20:59 IST = 15:29 UTC
    const date2059IST = new Date("2026-09-02T15:29:00.000Z").getTime();
    expect(isQuietHoursIST(date2059IST)).toBe(false);
  });

  it("handles non-finite timestamps safely", () => {
    expect(isQuietHoursIST(NaN)).toBe(false);
    expect(isQuietHoursIST(Infinity)).toBe(false);
  });

  it("policy engine suppresses contact action during quiet hours", () => {
    const policy = defaultPolicy();
    const quietTimeMs = new Date("2026-09-02T16:30:00.000Z").getTime(); // 22:00 IST

    const ctx: ConstraintContext = {
      failureClass: "SOFT_RETRYABLE",
      amountPaise: 499900,
      probabilityBp: 7500,
      nowMs: quietTimeMs,
      attemptsSoFar: 0,
      lastContactAtMs: null,
      customerOptedOut: false,
      isContactAction: true,
      paydayKnown: true,
      actionId: "REMINDER_LINK",
    };

    const violations = evaluateConstraints(policy, ctx);
    expect(violations).toContain("QUIET_HOURS");
  });
});
