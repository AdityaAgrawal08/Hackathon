import { describe, it, expect } from "vitest";
import {
  paise,
  rupeesToPaise,
  addP,
  subP,
  mulQty,
  percentBp,
  formatINR,
} from "../../packages/shared/src/money.js";
import {
  istMinuteOfDay,
  isWithinQuietHours,
  QUIET_START_MIN,
  QUIET_END_MIN,
} from "../../packages/shared/src/time.js";
import { clamp01, clamp } from "../../packages/shared/src/math.js";

const MAX_SAFE_P = Number.MAX_SAFE_INTEGER;

describe("money primitives — adversarial", () => {
  it("percentBp rounds half-away-from-zero at the exact .5 boundary", () => {
    expect(percentBp(paise(101), 5000)).toBe(51);
    expect(percentBp(paise(100), 5000)).toBe(50);
    expect(percentBp(paise(1), 5000)).toBe(1);
    expect(percentBp(paise(3), 3333)).toBe(1);
    expect(percentBp(paise(10000), 10000)).toBe(10000);
    expect(percentBp(paise(10000), 0)).toBe(0);
    expect(percentBp(paise(900719925), 10000)).toBe(900719925);
    expect(() => percentBp(paise(MAX_SAFE_P), 10000)).toThrow(/overflow/);
    expect(() => percentBp(paise(MAX_SAFE_P), 2)).toThrow(/overflow/);
  });

  it("rejects non-integer or non-finite constructions everywhere", () => {
    expect(() => paise(1.5)).toThrow();
    expect(() => paise(Number.NaN)).toThrow();
    expect(() => paise(Infinity)).toThrow();
    expect(() => rupeesToPaise(Number.NaN)).toThrow();
    expect(() => mulQty(paise(1), 1.5)).toThrow();
    expect(() => addP(paise(MAX_SAFE_P), paise(1))).toThrow();
  });

  it("subP can go negative and formats honestly", () => {
    const d = subP(paise(100), paise(250));
    expect(d).toBe(-150);
    expect(formatINR(d)).toBe("-₹1.50");
    expect(formatINR(paise(1))).toBe("₹0.01");
    expect(formatINR(paise(0))).toBe("₹0.00");
    expect(formatINR(rupeesToPaise(12345678.9))).toBe("₹1,23,45,678.90");
  });

  it("rupee conversion survives binary-float traps", () => {
    expect(rupeesToPaise(19.99)).toBe(1999);
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30);
    expect(rupeesToPaise(499.999999)).toBe(50000);
    expect(rupeesToPaise(-499.5)).toBe(-49950);
  });

  it("clamp01 and clamp fail-finite on NaN, Infinity, -Infinity", () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(-10)).toBe(0);
    expect(clamp01(10)).toBe(1);
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(0);
    expect(clamp01(-Infinity)).toBe(0);

    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(NaN, 0, 10)).toBe(0);
    expect(clamp(Infinity, 0, 10)).toBe(0);
  });
});

describe("IST time primitives — boundary torture", () => {
  const utcMs = (hUTC: number, minUTC = 0) => Date.UTC(2026, 0, 15, hUTC, minUTC);

  it("quiet window flips exactly at 22:00 and 08:00 IST (I-6)", () => {
    expect(istMinuteOfDay(utcMs(16, 29))).toBe(QUIET_START_MIN - 1);
    expect(isWithinQuietHours(utcMs(16, 29))).toBe(false);
    expect(istMinuteOfDay(utcMs(16, 30))).toBe(QUIET_START_MIN);
    expect(isWithinQuietHours(utcMs(16, 30))).toBe(true);
    expect(istMinuteOfDay(utcMs(2, 29))).toBe(QUIET_END_MIN - 1);
    expect(isWithinQuietHours(utcMs(2, 29))).toBe(true);
    expect(istMinuteOfDay(utcMs(2, 30))).toBe(QUIET_END_MIN);
    expect(isWithinQuietHours(utcMs(2, 30))).toBe(false);
  });

  it("handles pre-epoch timestamps without negative-minute corruption", () => {
    const preEpoch = Date.UTC(1969, 11, 31, 18, 44, 0);
    const m = istMinuteOfDay(preEpoch);
    expect(m).toBeGreaterThanOrEqual(0);
    expect(m).toBeLessThan(1440);
  });

  it("zero-length custom windows are never quiet; same-day windows hold", () => {
    expect(isWithinQuietHours(utcMs(12), 600, 600)).toBe(false);
    expect(isWithinQuietHours(utcMs(6, 0), 660, 780)).toBe(true);
    expect(isWithinQuietHours(utcMs(7, 29), 660, 780)).toBe(true);
    expect(isWithinQuietHours(utcMs(7, 30), 660, 780)).toBe(false);
  });
});
