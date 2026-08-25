/**
 * Evaluation metrics — computed on HOLDOUT only (bug P2-B6 prevention).
 * AUC uses the Mann–Whitney rank formulation with averaged tie ranks and a
 * deterministic sort (score asc, index asc) so ties never flip results.
 */
import { hashSeed } from "@arbiter/shared";

export function auc(scores: number[], labels: number[]): number {
  if (scores.length !== labels.length || scores.length === 0) {
    throw new Error("auc: bad shapes");
  }
  const idx = scores
    .map((_, i) => i)
    .sort((a, b) => (scores[a] as number) - (scores[b] as number) || a - b);

  const ranks = new Array<number>(scores.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (
      j + 1 < idx.length &&
      (scores[idx[j + 1] as number] as number) === (scores[idx[i] as number] as number)
    ) {
      j++;
    }
    const avgRank = (i + j) / 2 + 1; // 1-based
    for (let k = i; k <= j; k++) ranks[idx[k] as number] = avgRank;
    i = j + 1;
  }

  let sumPos = 0;
  let nPos = 0;
  let nNeg = 0;
  for (let k = 0; k < scores.length; k++) {
    if ((labels[k] as number) === 1) {
      sumPos += ranks[k] as number;
      nPos++;
    } else nNeg++;
  }
  if (nPos === 0 || nNeg === 0) throw new Error("auc: undefined — single class present");
  return (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

export function brier(scores: number[], labels: number[]): number {
  if (scores.length === 0) throw new Error("brier: empty");
  let s = 0;
  for (let i = 0; i < scores.length; i++) {
    const d = (scores[i] as number) - (labels[i] as number);
    s += d * d;
  }
  return s / scores.length;
}

export interface CalibrationBin {
  bin: number;
  count: number;
  meanPredicted: number;
  empiricalRate: number;
}

/** Equal-width bins over [0,1]. Value 1.0 lands in the last bin. */
export function calibrationBins(
  scores: number[],
  labels: number[],
  bins = 10,
): CalibrationBin[] {
  const acc = Array.from({ length: bins }, (_, bin) => ({
    bin,
    count: 0,
    predSum: 0,
    posSum: 0,
  }));
  for (let i = 0; i < scores.length; i++) {
    const s = Math.min(1, Math.max(0, scores[i] as number));
    const b = Math.min(bins - 1, Math.floor(s * bins));
    const slot = acc[b] as { count: number; predSum: number; posSum: number };
    slot.count++;
    slot.predSum += s;
    slot.posSum += labels[i] as number;
  }
  return acc.map(({ bin, count, predSum, posSum }) => ({
    bin,
    count,
    meanPredicted: count === 0 ? 0 : predSum / count,
    empiricalRate: count === 0 ? 0 : posSum / count,
  }));
}

export interface PerClassStat {
  failureClass: string;
  /** Holdout rows in this class. */
  n: number;
  /** Rows in this class whose realized label was recovery. */
  positives: number;
  /** Mean predicted score — calibration-at-a-glance per class. */
  meanScore: number;
  /**
   * Recall@threshold among this class's actual recoveries.
   * null when the class has zero positive labels (e.g. HARD_METHOD_DEAD
   * never recovers by design) — reported as null, never faked as 0.
   */
  recall: number | null;
}

/**
 * One-vs-rest recall per failure class at a fixed score threshold.
 * Classes are enumerated from the rows themselves (alphabetically sorted —
 * deterministic regardless of arrival order).
 */
export function perClassRecall(
  scores: number[],
  labels: number[],
  rowClasses: readonly string[],
  threshold = 0.5,
): PerClassStat[] {
  if (scores.length !== labels.length || scores.length !== rowClasses.length) {
    throw new Error("perClassRecall: bad shapes");
  }
  const distinct = [...new Set(rowClasses)].sort();
  return distinct.map((cls) => {
    let n = 0;
    let positives = 0;
    let hits = 0;
    let scoreSum = 0;
    for (let i = 0; i < scores.length; i++) {
      if (rowClasses[i] !== cls) continue;
      n++;
      scoreSum += scores[i] as number;
      if ((labels[i] as number) === 1) {
        positives++;
        if ((scores[i] as number) >= threshold) hits++;
      }
    }
    return {
      failureClass: cls,
      n,
      positives,
      meanScore: n === 0 ? 0 : scoreSum / n,
      recall: positives === 0 ? null : hits / positives,
    };
  });
}

/**
 * Customer-disjoint train/holdout split (anti-leakage P2-B1).
 * Bucketing via FNV hash ⇒ deterministic, no RNG state shared with anything.
 */
export function splitByCustomer<T extends { customerId: string }>(
  rows: readonly T[],
  trainFraction = 0.7,
): { train: T[]; holdout: T[] } {
  const train: T[] = [];
  const holdout: T[] = [];
  for (const row of rows) {
    const bucket = hashSeed(row.customerId) % 1000;
    (bucket / 1000 < trainFraction ? train : holdout).push(row);
  }
  return { train, holdout };
}

export function assertDisjoint(a: Set<string>, b: Set<string>, label: string): void {
  for (const id of a) {
    if (b.has(id)) throw new Error(`split leakage: ${id} in both sets (${label})`);
  }
}
