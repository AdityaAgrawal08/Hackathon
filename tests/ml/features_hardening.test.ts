import { describe, it, expect } from "vitest";
import { computeFeatures, inferPayday } from "../../packages/ml/src/features.js";
import { trainLogistic } from "../../packages/ml/src/logreg.js";
import { stableSigmoid } from "../../packages/ml/src/logreg.js";

const VALID = {
  failureCode: "INSUFFICIENT_FUNDS",
  amountPaise: 49_900,
  occurredAtUtc: "2026-02-14T09:00:00.000Z",
  priorFailureAmountsPaise: [],
  priorFailureCount: 0,
};

describe("computeFeatures — garbage rejection (fail closed)", () => {
  it("rejects zero, negative, fractional and non-finite amounts (I-5)", () => {
    for (const bad of [0, -100, 49.9, Number.NaN, Infinity]) {
      expect(() => computeFeatures({ ...VALID, amountPaise: bad as number })).toThrow(/amount/);
    }
  });

  it("rejects unparseable event timestamps", () => {
    expect(() =>
      computeFeatures({ ...VALID, occurredAtUtc: "not-a-date" }),
    ).toThrow(/occurredAtUtc/);
    expect(() => computeFeatures({ ...VALID, occurredAtUtc: "" })).toThrow(/occurredAtUtc/);
  });

  it("rejects corrupted prior-history amounts", () => {
    expect(() =>
      computeFeatures({ ...VALID, priorFailureAmountsPaise: [10_000, -5] }),
    ).toThrow(/prior amount/);
    expect(() =>
      computeFeatures({ ...VALID, priorFailureAmountsPaise: [10_000.5] }),
    ).toThrow(/prior amount/);
  });

  it("still accepts the smallest legitimate payment", () => {
    const f = computeFeatures({ ...VALID, amountPaise: 1 });
    expect(f.values.every(Number.isFinite)).toBe(true);
  });

  it("handles far-past and future-dated events without NaN", () => {
    const past = computeFeatures({ ...VALID, occurredAtUtc: "2000-01-01T00:00:00.000Z" });
    const future = computeFeatures({ ...VALID, occurredAtUtc: "2099-12-31T23:59:59.000Z" });
    expect(past.values.every(Number.isFinite)).toBe(true);
    expect(future.values.every(Number.isFinite)).toBe(true);
  });
});

describe("inferPayday — degenerate histograms", () => {
  it("ignores junk keys and negative counts gracefully", () => {
    const r = inferPayday({ abc: 3, "-4": 1, "27": 5 });
    expect(r.day).toBe(27);
    expect(r.observations).toBe(6);
  });

  it("treats all-zero histogram as no data", () => {
    const r = inferPayday({ "25": 0, "26": 0 });
    expect(r.day).toBeNull();
    expect(r.confidence).toBe(0);
  });
});

describe("trainLogistic — degenerate configurations", () => {
  it("epochs=0 returns a valid zero model with finite loss", () => {
    const r = trainLogistic([[1, 2], [3, 4]], [0, 1], { epochs: 0 });
    expect(r.weights).toEqual([0, 0]);
    expect(r.bias).toBe(0);
    expect(Number.isFinite(r.finalLoss)).toBe(true);
  });

  it("lr=0 keeps weights at init without divergence", () => {
    const r = trainLogistic([[1], [2], [3]], [0, 1, 1], { epochs: 10, learningRate: 0 });
    expect(r.weights).toEqual([0]);
  });

  it("single-class labels train but sigmoid saturates honestly", () => {
    const r = trainLogistic([[1], [2], [3]], [1, 1, 1], { epochs: 50 });
    const p = stableSigmoid(r.bias + r.weights[0]! * 1);
    expect(p).toBeGreaterThan(0.9);
  });

  it("extreme feature magnitudes do not produce non-finite weights", () => {
    const r = trainLogistic(
      [[1e8], [-1e8], [1e8]],
      [1, 0, 1],
      { epochs: 20, learningRate: 0.5 },
    );
    expect(r.weights.every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(r.bias)).toBe(true);
  });
});
