/**
 * P2 training orchestration — pure, DB-free, fully deterministic.
 * Pipeline: dataset → customer-disjoint split → logreg fit → HOLDOUT-ONLY
 * evaluation (AUC / Brier / calibration / per-class recall) → immutable
 * artifact. Running it twice on the same corpus MUST yield the same
 * weightsSha256 — the CI gate test enforces exactly that (P2-B5).
 */
import { trainLogistic, type TrainOptions } from "./logreg.js";
import { buildTrainingDataset, type CorpusLike, type DatasetRow } from "./dataset.js";
import { FEATURE_NAMES } from "./features.js";
import {
  auc,
  brier,
  calibrationBins,
  perClassRecall,
  splitByCustomer,
  assertDisjoint,
  type CalibrationBin,
  type PerClassStat,
} from "./metrics.js";
import { scoreWithArtifact } from "./predict.js";
import { buildArtifact, type ModelArtifact } from "./artifact.js";

export const DEFAULT_TRAIN_OPTS: Required<TrainOptions> = {
  epochs: 2000,
  learningRate: 0.3,
  lrDecay: 0.002,
  l2: 0.01,
};

export interface MetricsReport {
  auc: number;
  brier: number;
  calibration: CalibrationBin[];
  perClass: PerClassStat[];
  counts: {
    trainRows: number;
    holdoutRows: number;
    trainPositives: number;
    holdoutPositives: number;
    trainCustomers: number;
    holdoutCustomers: number;
  };
  hyper: Required<TrainOptions>;
}

export interface TrainOutcome {
  artifact: ModelArtifact;
  report: MetricsReport;
  datasetSkipped: number;
}

function countPositives(rows: readonly DatasetRow[]): number {
  let n = 0;
  for (const r of rows) n += r.label;
  return n;
}

/**
 * Fit + evaluate. Throws on any leakage (shared customers across splits) —
 * fail-closed beats silently-inflated metrics (P2-B1).
 */
export function trainAndEvaluate(corpus: CorpusLike, opts: TrainOptions = {}): TrainOutcome {
  const hyper = { ...DEFAULT_TRAIN_OPTS, ...opts };
  const dataset = buildTrainingDataset(corpus);

  const { train, holdout } = splitByCustomer(dataset.rows, 0.7);
  if (train.length === 0 || holdout.length === 0) {
    throw new Error("trainAndEvaluate: degenerate split");
  }
  assertDisjoint(
    new Set(train.map((r) => r.customerId)),
    new Set(holdout.map((r) => r.customerId)),
    "train/holdout",
  );

  const fit = trainLogistic(
    train.map((r) => r.values),
    train.map((r) => r.label),
    hyper,
  );

  // ── HOLDOUT-ONLY metrics (P2-B6: never report train-set calibration)
  const model = {
    featureNames: FEATURE_NAMES,
    weights: fit.weights,
    bias: fit.bias,
    mu: fit.mu,
    sigma: fit.sigma,
  };

  const scores = holdout.map((r) => scoreWithArtifact(r.values, model).probability);
  const labels = holdout.map((r) => r.label);

  const report: MetricsReport = {
    auc: auc(scores, labels),
    brier: brier(scores, labels),
    calibration: calibrationBins(scores, labels, 10),
    perClass: perClassRecall(scores, labels, holdout.map((r) => r.failureClass)),
    counts: {
      trainRows: train.length,
      holdoutRows: holdout.length,
      trainPositives: countPositives(train),
      holdoutPositives: countPositives(holdout),
      trainCustomers: new Set(train.map((r) => r.customerId)).size,
      holdoutCustomers: new Set(holdout.map((r) => r.customerId)).size,
    },
    hyper,
  };

  const artifact = buildArtifact({
    weights: fit.weights,
    bias: fit.bias,
    mu: fit.mu,
    sigma: fit.sigma,
    metricsJson: JSON.stringify(report),
    datasetSha256: dataset.sha256,
    trainedAtUtc: "", // stamped by caller (CLI/publisher), never by a live clock inside math
  });

  return { artifact, report, datasetSkipped: dataset.skipped };
}
