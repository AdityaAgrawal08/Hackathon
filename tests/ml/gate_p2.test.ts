/**
 * ═══════════════════════ PHASE P2 GATE ═══════════════════════
 * Plan-mandated exit criteria, enforced as executable checks:
 *  1. holdout AUC ≥ 0.75 with calibration monotone-ish (honest actuals)
 *  2. retrain-twice ⇒ identical weights sha (byte-determinism, P2-B5)
 *  3. leakage assertions green: customer-disjoint split (P2-B1)
 *  Every metric is computed on HOLDOUT only (P2-B6).
 */
import { describe, it, expect } from "vitest";
import { generateCorpus } from "../../packages/seed/src/generate.js";
import { buildTrainingDataset } from "../../packages/ml/src/dataset.js";
import { splitByCustomer, assertDisjoint } from "../../packages/ml/src/metrics.js";
import { trainAndEvaluate, type TrainOutcome } from "../../packages/ml/src/train.js";

// Full-size corpus — same shape the CLI trains on. Generated once.
const CORPUS = generateCorpus("training", { customerCount: 1200, targetEvents: 5000 });
let cached: TrainOutcome | null = null;
function outcome(): TrainOutcome {
  if (!cached) cached = trainAndEvaluate(CORPUS);
  return cached;
}

describe("P2 gate", () => {
  it("split is customer-disjoint; every training event labeled exactly once (P2-B1)", () => {
    const ds = buildTrainingDataset(CORPUS);
    expect(ds.skipped).toBe(0); // TRAINING corpus must be fully labeled

    const ids = new Set<string>();
    for (const r of ds.rows) {
      expect(ids.has(r.eventId)).toBe(false);
      ids.add(r.eventId);
    }
    expect(ids.size).toBe(CORPUS.events.length);

    const { train, holdout } = splitByCustomer(ds.rows, 0.7);
    assertDisjoint(
      new Set(train.map((r) => r.customerId)),
      new Set(holdout.map((r) => r.customerId)),
      "gate",
    );
  });

  it("holdout AUC ≥ 0.75 with sane Brier and coverage", () => {
    const o = outcome();
    expect(o.report.auc).toBeGreaterThanOrEqual(0.75);
    expect(o.report.brier).toBeLessThan(0.25);

    // Holdout actually used, not train masquerading as eval
    const totalRows = CORPUS.events.length;
    expect(o.report.counts.trainRows + o.report.counts.holdoutRows).toBe(totalRows);
    expect(o.report.counts.trainCustomers + o.report.counts.holdoutCustomers).toBe(
      CORPUS.customers.length,
    );
  });

  it("calibration is monotone-ish on holdout — reported honestly", () => {
    const bins = outcome().report.calibration.filter((b) => b.count >= 20);
    expect(bins.length).toBeGreaterThanOrEqual(3); // real spread, not one spike

    let inversions = 0;
    for (let i = 1; i < bins.length; i++) {
      if (bins[i]!.empiricalRate < bins[i - 1]!.empiricalRate - 0.15) inversions++;
    }
    expect(inversions).toBeLessThanOrEqual(2); // small-sample wobble allowed, chaos is not
  });

  it("per-class recall tells the truth: dead methods report null recall", () => {
    const perClass = outcome().report.perClass;
    const hard = perClass.find((c) => c.failureClass === "HARD_METHOD_DEAD");
    expect(hard).toBeDefined();
    expect(hard!.positives).toBe(0); // generator truth: dead method never recovers
    expect(hard!.recall).toBeNull(); // model layer refuses to fake a number

    const net = perClass.find((c) => c.failureClass === "NETWORK_TIMEOUT");
    expect(net!.positives).toBeGreaterThan(0);
    expect(net!.meanScore).toBeGreaterThan(0.4); // timeouts are visibly recoverable
  });

  it("retrain-twice ⇒ byte-identical artifact sha (P2-B5)", async () => {
    const first = trainAndEvaluate(CORPUS);
    const second = trainAndEvaluate(CORPUS);

    expect(first.artifact.weightsSha256).toBe(second.artifact.weightsSha256);
    expect(first.artifact.id).toBe(second.artifact.id);
    expect(first.artifact.weights).toEqual(second.artifact.weights);
    expect(first.report.auc).toBe(second.report.auc);
    expect(first.artifact.datasetSha256).toBe(second.artifact.datasetSha256);

    // The published artifact carries its own verification material:
    // weights sha covers weights+bias+μ+σ+feature pinning.
    expect(first.artifact.featureNames.length).toBe(first.artifact.weights.length);
  });
});
