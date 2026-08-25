import { describe, it, expect } from "vitest";
import { istMinuteOfDay, isWithinQuietHours, ledgerTimestamp } from "@arbiter/shared";

/**
 * Boundary fixtures (bug P1-B4 / P5-B7): UTC ms chosen so IST minute-of-day
 * hits 21:59 / 22:00 / 07:59 / 08:00 exactly.
 * IST = UTC+5:30 ⇒ IST 22:00 = 16:30 UTC.
 */
function utcMsOn(y: number, mo: number, d: number, hUtc: number, min: number): number {
  return Date.UTC(y, mo - 1, d, hUtc, min, 0);
}

describe("time (invariant I-6: single IST conversion point)", () => {
  it("converts UTC → IST minute-of-day", () => {
    // 16:29 UTC = 21:59 IST ; 16:30 UTC = 22:00 IST
    expect(istMinuteOfDay(utcMsOn(2026, 8, 25, 16, 29))).toBe(21 * 60 + 59);
    expect(istMinuteOfDay(utcMsOn(2026, 8, 25, 16, 30))).toBe(22 * 60);
    // 02:29 UTC = 07:59 IST ; 02:30 UTC = 08:00 IST
    expect(istMinuteOfDay(utcMsOn(2026, 8, 26, 2, 29))).toBe(7 * 60 + 59);
    expect(istMinuteOfDay(utcMsOn(2026, 8, 26, 2, 30))).toBe(8 * 60);
  });

  it("quiet window is [start, end): 22:00 quiet, 08:00 not quiet", () => {
    expect(isWithinQuietHours(utcMsOn(2026, 8, 25, 16, 30))).toBe(true); // 22:00 IST
    expect(isWithinQuietHours(utcMsOn(2026, 8, 25, 16, 29))).toBe(false); // 21:59 IST
    expect(isWithinQuietHours(utcMsOn(2026, 8, 26, 2, 30))).toBe(false); // 08:00 IST
    expect(isWithinQuietHours(utcMsOn(2026, 8, 26, 2, 29))).toBe(true); // 07:59 IST
    // deep night and mid-day
    expect(isWithinQuietHours(utcMsOn(2026, 8, 25, 20, 0))).toBe(true); // 01:30 IST
    expect(isWithinQuietHours(utcMsOn(2026, 8, 25, 9, 0))).toBe(false); // 14:30 IST
  });

  it("handles midnight rollover of the window", () => {
    // 23:59 IST and 00:01 IST both inside 22:00–08:00
    expect(istMinuteOfDay(utcMsOn(2026, 8, 25, 18, 29))).toBe(23 * 60 + 59);
    expect(isWithinQuietHours(utcMsOn(2026, 8, 25, 18, 29))).toBe(true);
    expect(isWithinQuietHours(utcMsOn(2026, 8, 25, 18, 31))).toBe(true); // 00:01 IST next day
  });

  it("custom windows and zero-length window", () => {
    const t1300 = utcMsOn(2026, 8, 25, 7, 30); // 13:00 IST
    expect(isWithinQuietHours(t1300, 13 * 60, 14 * 60)).toBe(true);
    expect(isWithinQuietHours(t1300, 14 * 60, 13 * 60)).toBe(false);
    expect(isWithinQuietHours(t1300, 5 * 60, 5 * 60)).toBe(false); // never quiet
  });

  it("ledger timestamp embeds both UTC and IST", () => {
    const s = ledgerTimestamp(utcMsOn(2026, 8, 25, 16, 30));
    expect(s).toContain("2026-08-25T16:30:00.000Z");
    expect(s).toContain("[22:00 IST]"); // 16:30 UTC + 5:30 = 22:00 IST
  });
});
