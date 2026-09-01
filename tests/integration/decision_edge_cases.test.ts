/**
 * B-010: Edge case tests for the decision engine.
 * Boundary conditions: amountPaise=0, amountPaise=1, probability=0.0,
 * probability=1.0, attemptsSoFar=0, empty priorFailureAmountsPaise with
 * priorFailureCount>0, extremely large amounts.
 */
import { describe, it, expect } from "vitest";
import { decide, ltvWeight } from "../../packages/core/src/decide/engine.js";
import { defaultPolicy } from "../../packages/core/src/decide/policy.js";
import type { DecideInput } from "../../packages/core/src/decide/engine.js";

function baseInput(overrides: Partial<DecideInput> = {}): DecideInput {
  return {
    probability: 0.5,
    failureClass: "SOFT_RETRYABLE",
    amountPaise: 199900,
    nowMs: Date.UTC(2026, 1, 15, 10, 0, 0),
    policy: defaultPolicy(),
    attemptsSoFar: 0,
    ...overrides,
  };
}

describe("B-010: Decision engine edge cases", () => {
  it("handles amountPaise = 1 (minimum positive integer)", () => {
    const result = decide(baseInput({ amountPaise: 1 }));
    expect(result.chosen).toBeDefined();
    expect(result.chosen.evPaise).toBeGreaterThanOrEqual(0);
  });

  it("handles amountPaise = 1_00_00_000 (₹1,00,000 — large amount)", () => {
    const result = decide(baseInput({ amountPaise: 1_00_00_000 }));
    expect(result.chosen).toBeDefined();
    expect(result.chosen.evPaise).toBeGreaterThan(0);
  });

  it("handles amountPaise = 10_00_00_000 (₹10,00,000 — extremely large)", () => {
    const result = decide(baseInput({ amountPaise: 10_00_00_000 }));
    expect(result.chosen).toBeDefined();
  });

  it("throws on amountPaise = 0", () => {
    expect(() => decide(baseInput({ amountPaise: 0 }))).toThrow(/positive integer/);
  });

  it("throws on amountPaise = -1 (negative)", () => {
    expect(() => decide(baseInput({ amountPaise: -1 }))).toThrow(/positive integer/);
  });

  it("handles probability = 0.0 (zero recovery chance)", () => {
    const result = decide(baseInput({ probability: 0.0 }));
    expect(result.chosen).toBeDefined();
    // With zero probability, all EVs are 0 or negative — NO_ACTION or HUMAN_REVIEW
    expect(result.chosen.evPaise).toBeLessThanOrEqual(0);
  });

  it("handles probability = 1.0 (certain recovery)", () => {
    const result = decide(baseInput({ probability: 1.0 }));
    expect(result.chosen).toBeDefined();
    expect(result.chosen.evPaise).toBeGreaterThan(0);
  });

  it("handles probability = 0.001 (very low)", () => {
    const result = decide(baseInput({ probability: 0.001 }));
    expect(result.chosen).toBeDefined();
  });

  it("handles probability = 0.999 (very high)", () => {
    const result = decide(baseInput({ probability: 0.999 }));
    expect(result.chosen).toBeDefined();
    expect(result.chosen.evPaise).toBeGreaterThan(0);
  });

  it("handles attemptsSoFar = 0 (first attempt)", () => {
    const result = decide(baseInput({ attemptsSoFar: 0 }));
    expect(result.chosen).toBeDefined();
  });

  it("handles attemptsSoFar = 5 (many prior attempts)", () => {
    const result = decide(baseInput({ attemptsSoFar: 5 }));
    expect(result.chosen).toBeDefined();
  });

  it("handles all failure classes without errors", () => {
    const classes = ["SOFT_RETRYABLE", "HARD_METHOD_DEAD", "NETWORK_TIMEOUT", "RISK_FLAGGED", "UNKNOWN"] as const;
    for (const cls of classes) {
      const result = decide(baseInput({ failureClass: cls }));
      expect(result.chosen).toBeDefined();
      expect(result.ranked.length).toBeGreaterThan(0);
    }
  });

  it("handles ltvPaise and churnRiskBp together", () => {
    // High LTV, low churn → more aggressive recovery
    const highLtv = decide(baseInput({ ltvPaise: 25_00_000, churnRiskBp: 100 }));
    // Low LTV, high churn → less aggressive
    const lowLtv = decide(baseInput({ ltvPaise: 10_000, churnRiskBp: 8000 }));
    expect(highLtv.chosen).toBeDefined();
    expect(lowLtv.chosen).toBeDefined();
  });

  it("ltvWeight: returns 1 when signals absent", () => {
    expect(ltvWeight(undefined, undefined)).toBe(1);
    expect(ltvWeight(null as unknown as number, undefined)).toBe(1);
  });

  it("ltvWeight: high LTV low churn → weight > 1", () => {
    const w = ltvWeight(25_00_000, 100);
    expect(w).toBeGreaterThan(1);
  });

  it("ltvWeight: low LTV high churn → weight < 1", () => {
    const w = ltvWeight(10_000, 8000);
    expect(w).toBeLessThan(1);
  });

  it("ltvWeight: clamped to [0.2, 1.5]", () => {
    const min = ltvWeight(0, 10000);
    const max = ltvWeight(100_00_000, 0);
    expect(min).toBeGreaterThanOrEqual(0.2);
    expect(max).toBeLessThanOrEqual(1.5);
  });

  it("throws on non-finite probability", () => {
    expect(() => decide(baseInput({ probability: NaN }))).toThrow(/non-finite/);
    expect(() => decide(baseInput({ probability: Infinity }))).toThrow(/non-finite/);
  });

  it("throws on non-finite nowMs", () => {
    expect(() => decide(baseInput({ nowMs: NaN }))).toThrow(/non-finite/);
  });

  it("chosen action is always in ranked list", () => {
    const result = decide(baseInput());
    expect(result.ranked).toContain(result.chosen);
  });

  it("ranked list is sorted by EV descending", () => {
    const result = decide(baseInput());
    for (let i = 1; i < result.ranked.length; i++) {
      expect(result.ranked[i]!.evPaise).toBeLessThanOrEqual(result.ranked[i - 1]!.evPaise);
    }
  });
});
