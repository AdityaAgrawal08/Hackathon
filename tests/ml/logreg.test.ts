/**
 * P2 unit gates — logistic regression core.
 *  - stableSigmoid never overflows (P2-B4)
 *  - training is byte-deterministic (P2-B5)
 *  - loss decreases; malformed input fails closed (I-7)
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { stableSigmoid, trainLogistic } from "../../packages/ml/src/logreg.js";

/** Deterministic synthetic separable set — no RNG anywhere. */
function syntheticSet(n = 200): { x: number[][]; y: number[] } {
  const x: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i * 37) % 100) / 50 - 1; // [-1, 1)
    const b = ((i * 61) % 97) / 48 - 1;
    x.push([a, b, a * b]);
    y.push(a + b + a * b > 0 ? 1 : 0);
  }
  return { x, y };
}

describe("stableSigmoid", () => {
  it("returns finite values across z ∈ [-50, 50] (P2-B4)", () => {
    for (let z = -50; z <= 50; z += 0.37) {
      const p = stableSigmoid(z);
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("survives extreme inputs without overflow", () => {
    expect(stableSigmoid(1000)).toBe(1);
    expect(stableSigmoid(-1000)).toBe(0);
    expect(stableSigmoid(0)).toBe(0.5);
  });

  it("is monotonically non-decreasing", () => {
    let prev = 0;
    for (let z = -30; z <= 30; z += 0.5) {
      const p = stableSigmoid(z);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it("throws on non-finite z (fail closed)", () => {
    expect(() => stableSigmoid(Number.NaN)).toThrow();
    expect(() => stableSigmoid(Infinity)).toThrow();
  });
});

describe("trainLogistic determinism + sanity", () => {
  it("produces bit-identical weights across runs (P2-B5)", () => {
    const { x, y } = syntheticSet();
    const a = trainLogistic(x, y);
    const b = trainLogistic(x, y);
    expect(JSON.stringify(a.weights)).toBe(JSON.stringify(b.weights));
    expect(a.bias).toBe(b.bias);
    expect(a.finalLoss).toBe(b.finalLoss);

    const shaA = createHash("sha256").update(JSON.stringify([a.weights, a.bias])).digest("hex");
    const shaB = createHash("sha256").update(JSON.stringify([b.weights, b.bias])).digest("hex");
    expect(shaA).toBe(shaB);
  });

  it("decreases loss and learns the separable signal", () => {
    const { x, y } = syntheticSet(400);
    const r = trainLogistic(x, y, { epochs: 500 });
    expect(r.finalLoss).toBeLessThan(r.firstLoss);

    // Accuracy on the training set should be well above chance.
    let correct = 0;
    for (let i = 0; i < x.length; i++) {
      let z = r.bias;
      for (let j = 0; j < x[i]!.length; j++) z += r.weights[j]! * x[i]![j]!;
      const pred = stableSigmoid(z) >= 0.5 ? 1 : 0;
      correct += pred === y[i] ? 1 : 0;
    }
    expect(correct / x.length).toBeGreaterThan(0.85);
  });

  it("rejects malformed input (fail closed, I-7)", () => {
    expect(() => trainLogistic([], [])).toThrow();
    expect(() => trainLogistic([[1]], [])).toThrow();
    expect(() => trainLogistic([[1, 2], [1]], [0, 1])).toThrow(/ragged/);
    expect(() => trainLogistic([[Number.NaN, 1]], [0])).toThrow(/non-finite/);
  });
});
