import { describe, it, expect } from "vitest";
import { generateCorpus } from "../../packages/seed/src/generate.js";
import { trainAndEvaluate } from "../../packages/ml/src/train.js";
import { scoreWithArtifact } from "../../packages/ml/src/predict.js";

describe("Genuine ML Model Training & Holdout Evaluation (ML-03)", () => {
  const corpus = generateCorpus("training", { customerCount: 400, targetEvents: 1500 });

  it("trains customer-disjoint model with held-out AUC >= 0.75 and low Brier score", () => {
    const { artifact, report } = trainAndEvaluate(corpus, { epochs: 1000 });

    // 1. Customer-Disjoint Split Verification
    expect(report.counts.trainCustomers).toBeGreaterThan(0);
    expect(report.counts.holdoutCustomers).toBeGreaterThan(0);
    expect(report.counts.trainRows).toBeGreaterThan(report.counts.holdoutRows);

    // 2. Gate Metrics on Held-Out Test Set
    expect(report.auc).toBeGreaterThanOrEqual(0.75);
    expect(report.brier).toBeLessThanOrEqual(0.20);
    expect(report.calibration.length).toBe(10);

    // 3. Artifact Completeness
    expect(artifact.id).toBeDefined();
    expect(artifact.weights.length).toBe(22);
    expect(artifact.featureNames.length).toBe(22);
    expect(artifact.weightsSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces deterministic model weights on identical corpus", () => {
    const run1 = trainAndEvaluate(corpus, { epochs: 500 });
    const run2 = trainAndEvaluate(corpus, { epochs: 500 });

    expect(run1.artifact.weightsSha256).toBe(run2.artifact.weightsSha256);
    expect(run1.report.auc).toBeCloseTo(run2.report.auc, 6);
  });

  it("predict scoring reconstructs logits and produces valid probabilities", () => {
    const { artifact } = trainAndEvaluate(corpus, { epochs: 500 });
    const sampleFeatures = Array(22).fill(0.5);

    const score = scoreWithArtifact(sampleFeatures, artifact);
    expect(score.probability).toBeGreaterThan(0);
    expect(score.probability).toBeLessThan(1);
    expect(Number.isFinite(score.logit)).toBe(true);
    expect(score.attributions.length).toBeGreaterThan(0);
  });
});
