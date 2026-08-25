import { describe, it, expect } from "vitest";
import {
  nextPaydayWindowMs,
  istDayOfMonth,
  circularDayDistance,
  RETRY_HOUR_EST,
  IST_OFFSET_MS,
} from "../../packages/core/src/decide/window.js";

const DAY = 86_400_000;

describe("circularDayDistance", () => {
  it("measures shortest wrap-around distance", () => {
    expect(circularDayDistance(30, 1)).toBe(2);
    expect(circularDayDistance(1, 31)).toBe(1);
    expect(circularDayDistance(15, 15)).toBe(0);
    expect(circularDayDistance(10, 20)).toBe(10);
  });
});

describe("nextPaydayWindowMs", () => {
  const now = Date.UTC(2026, 2, 20, 6, 0, 0);

  function istParts(ms: number) {
    const d = new Date(ms + IST_OFFSET_MS);
    return { dom: d.getUTCDate(), hour: d.getUTCHours(), min: d.getUTCMinutes() };
  }

  it("lands on the first day within ±2 of payday at the retry hour", () => {
    const t = nextPaydayWindowMs(25, now);
    const p = istParts(t);
    expect(p.dom).toBe(23);
    expect(p.hour).toBe(RETRY_HOUR_EST);
    expect(p.min).toBe(0);
    expect(circularDayDistance(p.dom, 25)).toBeLessThanOrEqual(2);
    expect(t).toBeGreaterThan(now);
  });

  it("skips past month ends into the next cycle when needed", () => {
    const lateMonth = Date.UTC(2026, 2, 29, 12, 0, 0);
    const t = nextPaydayWindowMs(3, lateMonth);
    const p = istParts(t);
    expect(circularDayDistance(p.dom, 3)).toBeLessThanOrEqual(2);
    expect(new Date(t).getUTCMonth()).toBe(3);
    expect(p.hour).toBe(RETRY_HOUR_EST);
  });

  it("wraps payday day 1 against prior month-end days", () => {
    const t = nextPaydayWindowMs(1, Date.UTC(2026, 2, 30, 9, 0, 0));
    expect(circularDayDistance(istDayOfMonth(t), 1)).toBeLessThanOrEqual(2);
    expect(t).toBeGreaterThan(Date.UTC(2026, 2, 30, 9, 0, 0));
  });

  it("is deterministic and monotone vs clock", () => {
    expect(nextPaydayWindowMs(28, now)).toBe(nextPaydayWindowMs(28, now));
    expect(nextPaydayWindowMs(28, now + DAY)).toBeGreaterThanOrEqual(now + DAY);
  });

  it("rejects invalid inputs", () => {
    expect(() => nextPaydayWindowMs(0, now)).toThrow();
    expect(() => nextPaydayWindowMs(32, now)).toThrow();
    expect(() => nextPaydayWindowMs(Number.NaN, now)).toThrow();
    expect(() => nextPaydayWindowMs(28, Number.NaN)).toThrow();
  });
});
