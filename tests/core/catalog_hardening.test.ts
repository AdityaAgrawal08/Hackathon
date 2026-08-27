import { describe, it, expect } from "vitest";
import { multiplierFor, assertTableComplete, DEFAULT_ACTION_MULTIPLIERS, ACTIONS, FailureClassId } from "../../packages/core/src/decide/catalog.js";
import { paise, percentBp } from "../../packages/shared/src/money.js";

const NOW = Date.UTC(2026, 1, 16, 10, 0, 0);

describe("P8 — Catalog multiplier hardening", () => {
  it("assertTableComplete rejects incomplete tables", () => {
    // Table missing a cell should throw
    const incomplete = {
      SOFT_RETRYABLE: { RETRY_NOW: 0.6 },
      // missing RETRY_PAYDAY, ALTERNATE_UPI_LINK, etc.
    };
    expect(() => assertTableComplete(incomplete)).toThrow(
      "adjustment table incomplete"
    );
  });

  it("multiplierFor uses default table cells correctly", () => {
    // DEFAULT_ACTION_MULTIPLIERS has UNKNOWN: { RETRY_NOW: 0.1 }
    const result = multiplierFor("UNKNOWN", "RETRY_NOW", DEFAULT_ACTION_MULTIPLIERS);
    expect(result).toBe(0.1);
  });

  it("multiplierFor clamps custom table values to [0,10]", () => {
    const wild = {
      SOFT_RETRYABLE: { RETRY_NOW: 99, RETRY_PAYDAY: -5 },
    };
    const r = multiplierFor("SOFT_RETRYABLE", "RETRY_NOW", wild);
    expect(r).toBe(10); // clamped up
    const r2 = multiplierFor("SOFT_RETRYABLE", "RETRY_PAYDAY", wild);
    expect(r2).toBe(0); // clamped down, fail-closed
  });

  it("multiplierFor all ACTIONS × FailureClass combos exist in default table", () => {
    for (const cls of Object.keys(DEFAULT_ACTION_MULTIPLIERS) as FailureClassId[]) {
      for (const action of ACTIONS) {
        const m = multiplierFor(cls, action);
        expect(m).toBeGreaterThanOrEqual(0);
        expect(m).toBeLessThanOrEqual(10);
      }
    }
  });

  it("paise function throws for non-integer values", () => {
    expect(() => paise(3.14)).toThrow(); // float
    expect(() => paise(NaN)).toThrow(); // NaN
    expect(() => paise(Infinity)).toThrow(); // Infinity
  });

  it("paise function accepts valid integers", () => {
    expect(paise(0)).toBe(0);
    expect(paise(1)).toBe(1);
  });

  it("percentBp overflow guard for extreme values", () => {
    // Very large amount with very high probability should not overflow
    const result = percentBp(paise(1_000_000_000), 10_000);
    expect(Number.isFinite(result)).toBe(true);
    // Very small probability with large amount
    const result2 = percentBp(paise(1_000_000_000), 1);
    expect(Number.isFinite(result2)).toBe(true);
  });

  it("percentBp rounding is correct per audit spec", () => {
    // remainder >= 5000 rounds up
    const r1 = percentBp(paise(1), 5000); // 1 * 5000 / 10000 = 0 rem 5000 => bump => 1
    expect(r1).toBe(1);
    // remainder < 5000 rounds down
    const r2 = percentBp(paise(1), 1); // 1 * 1 / 10000 = 0 rem 1 => no bump => 0
    expect(r2).toBe(0);
  });
});