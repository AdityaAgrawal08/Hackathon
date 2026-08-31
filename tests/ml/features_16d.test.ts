import { describe, it, expect } from "vitest";
import {
  computeFeatures,
  FEATURE_NAMES,
  FEATURE_COUNT,
  type FeatureInput,
} from "../../packages/ml/src/features.js";

describe("23-Dimensional ML Feature Vector Specification (Task 1.2)", () => {
  it("defines exactly 23 features in FEATURE_NAMES", () => {
    expect(FEATURE_NAMES.length).toBe(23);
    expect(FEATURE_COUNT).toBe(23);
    expect(FEATURE_NAMES).toContain("days_since_last_attempt_norm");
    expect(FEATURE_NAMES).toContain("high_value_tier");
    expect(FEATURE_NAMES).toContain("bank_rail_health_norm");
  });

  it("computes all 16 finite features without NaN or leaks", () => {
    const input: FeatureInput = {
      failureCode: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
      amountPaise: 1_250_000, // ₹12,500 (high-value tier)
      occurredAtUtc: "2026-08-28T10:00:00.000Z",
      priorFailureAmountsPaise: [50000, 100000],
      priorFailureCount: 2,
      customer: {
        paydayPattern: { "28": 5, "29": 2 },
        priorSuccessCount: 6,
        joinedAtUtc: "2025-01-01T00:00:00.000Z",
        channelResponsiveness: 0.8,
      },
    };

    const res = computeFeatures(input);
    expect(res.values.length).toBe(23);
    expect(res.values.every((v) => Number.isFinite(v))).toBe(true);

    // Verify specific feature semantics
    expect(res.raw.failureClass).toBe("SOFT_RETRYABLE");
    const highValueIdx = FEATURE_NAMES.indexOf("high_value_tier");
    expect(res.values[highValueIdx]).toBe(1); // ₹12,500 >= ₹10,000

    const nearPaydayIdx = FEATURE_NAMES.indexOf("near_payday");
    expect(res.values[nearPaydayIdx]).toBe(1); // event is on 28th, payday is 28th
  });

  it("handles cold-start / missing history with explicit finite sentinels", () => {
    const input: FeatureInput = {
      failureCode: "CARD_EXPIRED",
      amountPaise: 49900,
      occurredAtUtc: "2026-08-15T12:00:00.000Z",
      priorFailureAmountsPaise: [],
      priorFailureCount: 0,
      customer: null,
    };

    const res = computeFeatures(input);
    expect(res.values.length).toBe(23);
    expect(res.values.every((v) => Number.isFinite(v))).toBe(true);
    expect(res.raw.failureClass).toBe("HARD_METHOD_DEAD");

    const highValueIdx = FEATURE_NAMES.indexOf("high_value_tier");
    expect(res.values[highValueIdx]).toBe(0); // ₹499 < ₹10,000
  });
});
