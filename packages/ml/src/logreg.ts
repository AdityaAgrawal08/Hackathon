/**
 * Hand-rolled logistic regression — the auditable brain (P2).
 *
 * Design constraints (from ARBITER plan §3/§16):
 *  - BIT-DETERMINISM: zero-init weights, sequential fixed-order loops,
 *    full-batch gradient descent, fixed epoch count. Same data ⇒ same
 *    weights, bit-for-bit, on any machine (test enforces sha equality).
 *  - NO DEPENDENCIES: ~150 auditable lines; coefficients ARE the
 *    explanation layer.
 *  - Standardization constants (μ/σ) are learned on TRAIN rows only and
 *    shipped inside the artifact — inference must never recompute them
 *    from different data (silent skew bug class).
 */

/** Numerically stable logistic: never overflows, exact at extremes. */
export function stableSigmoid(z: number): number {
  if (!Number.isFinite(z)) throw new Error(`stableSigmoid: non-finite z=${z}`);
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

export interface TrainOptions {
  epochs?: number; // default 2000
  learningRate?: number; // default 0.3
  lrDecay?: number; // default 0.002 → lr_t = lr0/(1+decay·t)
  l2?: number; // default 0.01
}

export interface TrainResult {
  weights: number[];
  bias: number;
  mu: number[];
  sigma: number[];
  finalLoss: number;
  firstLoss: number;
}

function mean(values: number[]): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i] as number;
  return s / values.length;
}

/** Population standard deviation with a floor to avoid divide-by-zero. */
function std(values: number[], mu: number): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) {
    const d = (values[i] as number) - mu;
    s += d * d;
  }
  return Math.max(Math.sqrt(s / values.length), 1e-8);
}

/**
 * Train on standardized features.
 * Rows MUST be pre-sorted by a stable key by the caller (we do eventId)
 * so floating-point summation order is fixed forever.
 */
export function trainLogistic(
  x: number[][], // n × d raw feature values
  y: number[], // n labels ∈ {0,1}
  opts: TrainOptions = {},
): TrainResult {
  const epochs = opts.epochs ?? 2000;
  const lr0 = opts.learningRate ?? 0.3;
  const decay = opts.lrDecay ?? 0.002;
  const lambda = opts.l2 ?? 0.01;

  if (x.length === 0 || x.length !== y.length) {
    throw new Error(`trainLogistic: bad shapes x=${x.length} y=${y.length}`);
  }
  const d = x[0]!.length;
  for (const row of x) {
    if (row.length !== d) throw new Error("trainLogistic: ragged rows");
    for (const v of row) {
      if (!Number.isFinite(v)) throw new Error("trainLogistic: non-finite feature");
    }
  }

  // ── standardization constants from TRAINING data only
  const mu = new Array<number>(d).fill(0);
  const sigma = new Array<number>(d).fill(1);
  for (let j = 0; j < d; j++) {
    const col = x.map((r) => r[j] as number);
    const m = mean(col);
    mu[j] = m;
    sigma[j] = std(col, m) < 1e-6 ? 1 : std(col, m);
  }

  // Pre-standardize once (same result as per-epoch recompute; cheaper + fixed)
  const xs = x.map((row) => row.map((v, j) => ((v - mu[j]!) / sigma[j]!) as number));

  const w = new Array<number>(d).fill(0); // zero init — determinism
  let bias = 0;
  const n = xs.length;

  let firstLoss = Number.NaN;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const lr = lr0 / (1 + decay * epoch);

    // Full-batch gradients, sequential accumulation in fixed row order.
    const gw = new Array<number>(d).fill(0);
    let gb = 0;
    let loss = 0;

    for (let i = 0; i < n; i++) {
      const row = xs[i]!;
      const yi = y[i] as number;
      let z = bias;
      for (let j = 0; j < d; j++) z += w[j]! * row[j]!;
      const p = stableSigmoid(z);

      // Log-loss terms (clamped away from exact 0/1 for log safety).
      const pc = Math.min(1 - 1e-12, Math.max(1e-12, p));
      loss += -(yi * Math.log(pc) + (1 - yi) * Math.log(1 - pc));

      const err = p - yi;
      gb += err;
      for (let j = 0; j < d; j++) gw[j]! += err * row[j]!;
    }
    loss /= n;

    if (epoch === 0) firstLoss = loss;

    // L2 + gradient step (bias unregularized — standard practice)
    for (let j = 0; j < d; j++) {
      w[j] = w[j]! - lr * (gw[j]! / n + lambda * w[j]!);
    }
    bias -= lr * (gb / n);

    if (!Number.isFinite(loss)) {
      throw new Error(`trainLogistic: loss diverged at epoch ${epoch}`);
    }
  }

  // Recompute final loss cleanly for reporting (post-last-update state).
  let finalLoss = 0;
  for (let i = 0; i < n; i++) {
    const row = xs[i]!;
    let z = bias;
    for (let j = 0; j < d; j++) z += w[j]! * row[j]!;
    const pc = Math.min(1 - 1e-12, Math.max(1e-12, stableSigmoid(z)));
    const yi = y[i] as number;
    finalLoss += -(yi * Math.log(pc) + (1 - yi) * Math.log(1 - pc));
  }

  return { weights: w, bias, mu, sigma, finalLoss: finalLoss / n, firstLoss };
}
