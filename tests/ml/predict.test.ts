/**
 * P2 unit gates — inference scorer.
 * The attribution identity (Σ wᵢ·x̂ᵢ + bias === logit) is TESTED here,
 * not assumed: it is the foundation of every explanation we show a human.
 */
import { describe, it, expect } from "vitest";
import { scoreWithArtifact } from "../../packages/ml/src/predict.js";
import { stableSigmoid } from "../../packages/ml/src/logreg.js";

const MODEL = {
  featureNames: ["a", "b"],
  weights: [0.5, -0.3],
  bias: 0.25,
  mu: [1, 2],
  sigma: [2, 4],
};

describe("scoreWithArtifact", () => {
  it("reconstructs the logit exactly from attributions + bias", () => {
    const r = scoreWithArtifact([3, 1], MODEL);
    // x̂ = [(3-1)/2, (1-2)/4] = [1, -0.25]; z = 0.25 + 0.5·1 − 0.3·(−0.25)
    expect(r.logit).toBeCloseTo(0.25 + 0.5 - 0.3 * -0.25, 12);
    expect(r.probability).toBe(stableSigmoid(r.logit));

    let sum = MODEL.bias;
    for (const a of r.attributions) sum += a.contribution;
    // top-5 slice keeps everything for a 2-feature model
    expect(sum).toBeCloseTo(r.logit, 9);
  });

  it("sorts attributions by |contribution| descending", () => {
    const r = scoreWithArtifact([5, 1], MODEL); // x̂=[2,-0.25] → c=[1.0, 0.075]
    expect(r.attributions[0]!.feature).toBe("a");
    expect(Math.abs(r.attributions[0]!.contribution)).toBeGreaterThan(
      Math.abs(r.attributions[1]!.contribution),
    );
  });

  it("keeps at most 5 attributions (case-brief budget)", () => {
    const wide = {
      ...MODEL,
      featureNames: Array.from({ length: 11 }, (_, i) => `f${i}`),
      weights: Array.from({ length: 11 }, (_, i) => (i + 1) / 11),
      mu: new Array(11).fill(0),
      sigma: new Array(11).fill(1),
    };
    const r = scoreWithArtifact(wide.featureNames.map((_, i) => i), wide);
    expect(r.attributions.length).toBe(5);
    expect(r.attributions[0]!.feature).toBe("f10");
  });

  it("fails closed on wrong width or non-finite input", () => {
    expect(() => scoreWithArtifact([1, 2, 3], MODEL)).toThrow(/expected/);
    expect(() => scoreWithArtifact([Number.NaN, 1], MODEL)).toThrow();
  });
});
