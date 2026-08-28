/**
 * P2 unit gates — feature pipeline v1.
 *  - decision-time information only (P2-B2, by construction audit)
 *  - explicit sentinels for missing history, never NaN (P2-B7)
 *  - fail-closed classification of unknown codes (I-7)
 */
import { describe, it, expect } from "vitest";
import {
  computeFeatures,
  classifyByCode,
  inferPayday,
  deriveLtvSignals,
  FEATURE_COUNT,
  FEATURE_NAMES,
} from "../../packages/ml/src/features.js";

const CODES = {
  SOFT_RETRYABLE: ["INSUFFICIENT_FUNDS", "TEMPORARY_DECLINE", "NO_MANDATE_RESPONSE"],
  HARD_METHOD_DEAD: ["CARD_EXPIRED", "MANDATE_REVOKED", "TOKEN_INVALID"],
  NETWORK_TIMEOUT: ["GATEWAY_TIMEOUT", "ISSUER_TIMEOUT", "NETWORK_ERROR"],
  RISK_FLAGGED: ["SUSPECTED_FRAUD", "RISK_BLOCKED"],
  UNKNOWN: ["UNKNOWN_CODE"],
};

describe("classifyByCode", () => {
  it("resolves seeded codes to classes exactly", () => {
    expect(classifyByCode("INSUFFICIENT_FUNDS", CODES)).toBe("SOFT_RETRYABLE");
    expect(classifyByCode("card_expired", CODES)).toBe("HARD_METHOD_DEAD"); // case-insensitive
    expect(classifyByCode(" GATEWAY_TIMEOUT ", CODES)).toBe("NETWORK_TIMEOUT");
  });

  it("maps foreign codes to UNKNOWN — never guesses (I-7)", () => {
    expect(classifyByCode("SOMETHING_NEW", CODES)).toBe("UNKNOWN");
    expect(classifyByCode("", CODES)).toBe("UNKNOWN");
  });
});

describe("inferPayday", () => {
  it("returns null sentinel below 3 observations (P2-B7)", () => {
    expect(inferPayday(null).day).toBeNull();
    expect(inferPayday({}).day).toBeNull();
    const thin = inferPayday({ "27": 2 });
    expect(thin.day).toBeNull();
    expect(thin.observations).toBe(2);
  });

  it("picks the modal day; confidence = share of modal observations", () => {
    const r = inferPayday({ "25": 1, "27": 4, "28": 1 });
    expect(r.day).toBe(27);
    expect(r.confidence).toBeCloseTo(4 / 6, 10);
  });

  it("breaks ties toward the earlier day deterministically", () => {
    expect(inferPayday({ "28": 2, "26": 2, "1": 1 }).day).toBe(26);
  });
});

describe("computeFeatures", () => {
  const baseEvent = {
    failureCode: "INSUFFICIENT_FUNDS",
    amountPaise: 49_900,
    occurredAtUtc: "2026-01-28T10:00:00.000Z",
  };

  it("emits the pinned feature count with finite values only", () => {
    const f = computeFeatures({ ...baseEvent, priorFailureAmountsPaise: [], priorFailureCount: 0 });
    expect(f.values.length).toBe(FEATURE_COUNT);
    expect(FEATURE_NAMES.length).toBe(FEATURE_COUNT);
    for (const v of f.values) expect(Number.isFinite(v)).toBe(true);
  });

  it("new customer ⇒ documented sentinels, never undefined/NaN (P2-B7)", () => {
    const f = computeFeatures({
      ...baseEvent,
      priorFailureAmountsPaise: [],
      priorFailureCount: 0,
      customer: null,
    });
    expect(f.raw.inferredPaydayDay).toBeNull(); // no payday history
    expect(f.values[3 + 1]).toBe(0); // near_payday
    expect(f.values[3 + 2]).toBe(0); // payday_confidence
    expect(f.values[6]).toBe(0); // amount_z
    expect(f.values[9]).toBe(0.5); // channel_responsiveness default prior
  });

  it("fires near_payday within ±2 days circularly of inferred payday", () => {
    const cust = { paydayPattern: { "28": 5 }, channelResponsiveness: 0.6, priorSuccessCount: 5 };
    const near = computeFeatures({
      ...baseEvent,
      occurredAtUtc: "2026-01-30T10:00:00.000Z", // |30-28| = 2
      priorFailureAmountsPaise: [],
      priorFailureCount: 0,
      customer: cust,
    });
    expect(near.values[4]).toBe(1);

    const far = computeFeatures({
      ...baseEvent,
      occurredAtUtc: "2026-01-05T10:00:00.000Z",
      priorFailureAmountsPaise: [],
      priorFailureCount: 0,
      customer: cust,
    });
    expect(far.values[4]).toBe(0);
  });

  it("amount_z uses strictly-prior amounts and clamps to ±5", () => {
    const f = computeFeatures({
      ...baseEvent,
      amountPaise: 50_000_000, // ₹500k outlier
      priorFailureAmountsPaise: [49_900, 51_000],
      priorFailureCount: 2,
    });
    expect(f.values[6]).toBe(5);

    const first = computeFeatures({
      ...baseEvent,
      priorFailureAmountsPaise: [49_900], // <2 priors → z=0 sentinel
      priorFailureCount: 1,
    });
    expect(first.values[6]).toBe(0);
  });

  it("class onehot encodes the code-derived class (hint never trusted)", () => {
    const soft = computeFeatures({ ...baseEvent, priorFailureAmountsPaise: [], priorFailureCount: 0 });
    expect([soft.values[0], soft.values[1], soft.values[2], soft.values[3]]).toEqual([1, 0, 0, 0]);

    const hard = computeFeatures({
      ...baseEvent,
      failureCode: "CARD_EXPIRED",
      priorFailureAmountsPaise: [],
      priorFailureCount: 0,
    });
    expect(hard.raw.failureClass).toBe("HARD_METHOD_DEAD");
    expect(hard.values[1]).toBe(1);
  });

  it("tenure_norm grows with tenure and clamps at 1", () => {
    const recent = computeFeatures({
      ...baseEvent,
      priorFailureAmountsPaise: [],
      priorFailureCount: 0,
      customer: { joinedAtUtc: "2025-12-01T00:00:00.000Z" },
    });
    const ancient = computeFeatures({
      ...baseEvent,
      priorFailureAmountsPaise: [],
      priorFailureCount: 0,
      customer: { joinedAtUtc: "2020-01-01T00:00:00.000Z" },
    });
    expect(recent.values[10]).toBeGreaterThan(0);
    expect(recent.values[10]).toBeLessThan(ancient.values[10]!);
    expect(ancient.values[10]).toBeLessThanOrEqual(1);
  });

  it("LTV features: derived signals scale with priors/responsiveness/opt-out", () => {
    const whale = computeFeatures({
      ...baseEvent,
      priorFailureAmountsPaise: [],
      priorFailureCount: 0,
      customer: {
        paydayPattern: { "27": 3 },
        channelResponsiveness: 0.9,
        priorSuccessCount: 40,
        joinedAtUtc: "2020-01-01T00:00:00.000Z",
        optedOut: false,
      },
    });
    const churner = computeFeatures({
      ...baseEvent,
      priorFailureAmountsPaise: [],
      priorFailureCount: 0,
      customer: {
        paydayPattern: { "27": 3 },
        channelResponsiveness: 0.1,
        priorSuccessCount: 1,
        joinedAtUtc: "2026-01-01T00:00:00.000Z",
        optedOut: true,
      },
    });
    // ltv_paise_norm (idx 11) grows with prior success count
    expect(whale.values[11]!).toBeGreaterThan(churner.values[11]!);
    // churn_risk_norm (idx 12) higher for unresponsive + opted-out + new
    expect(churner.values[12]!).toBeGreaterThan(whale.values[12]!);
    for (const v of [whale.values[11]!, whale.values[12]!, churner.values[11]!, churner.values[12]!]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("deriveLtvSignals: LTV proxy = priorSuccessCount × avg ticket; churn rises with opt-out", () => {
    expect(
      deriveLtvSignals({ priorSuccessCount: 10, channelResponsiveness: 0.5, joinedAtUtc: "2025-01-01T00:00:00.000Z", optedOut: false }, "2026-01-01T00:00:00.000Z").ltvPaise,
    ).toBe(10 * 50_000);
    const a = deriveLtvSignals({ channelResponsiveness: 0.5, optedOut: false }, "2026-01-01T00:00:00.000Z").churnRiskBp;
    const b = deriveLtvSignals({ channelResponsiveness: 0.5, optedOut: true }, "2026-01-01T00:00:00.000Z").churnRiskBp;
    expect(b).toBeGreaterThan(a);
  });
});
