import { describe, it, expect } from "vitest";
import {
  paise,
  rupeesToPaise,
  addP,
  subP,
  mulQty,
  percentBp,
  formatINR,
} from "@arbiter/shared";

describe("money (invariant I-5: integer paise only)", () => {
  it("rejects non-integer construction", () => {
    expect(() => paise(10.5)).toThrow();
    expect(() => paise(Number.NaN)).toThrow();
    expect(() => paise(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("converts rupees with half-up rounding on magnitude", () => {
    expect(rupeesToPaise(499)).toBe(49900);
    expect(rupeesToPaise(0.005)).toBe(1); // 0.5p rounds up
    expect(rupeesToPaise(-0.005)).toBe(-1); // symmetric on negatives
  });

  it("add/sub/mul stay integer and throw on overflow", () => {
    const a = paise(100);
    const b = paise(250);
    expect(addP(a, b)).toBe(350);
    expect(subP(b, a)).toBe(150);
    expect(mulQty(a, 3)).toBe(300);
    expect(() => mulQty(a, 2.5)).toThrow();
  });

  it("percentBp rounds half-away-from-zero", () => {
    expect(percentBp(paise(999), 5000)).toBe(500); // 50% of ₹9.99
    expect(percentBp(paise(101), 5000)).toBe(51); // 50.5p → 51
    expect(percentBp(paise(-101), 5000)).toBe(-51);
    expect(percentBp(paise(100), 12_345)).toBe(123); // 123.45 → 123
  });

  it("formats Indian digit grouping deterministically (no ICU)", () => {
    expect(formatINR(paise(123456789))).toBe("₹12,34,567.89");
    expect(formatINR(paise(49900))).toBe("₹499.00");
    expect(formatINR(paise(100))).toBe("₹1.00");
    expect(formatINR(paise(50))).toBe("₹0.50");
    expect(formatINR(paise(-123456))).toBe("-₹1,234.56");
  });
});
