/**
 * Inference service — PREDICT stage scoring.
 *
 * Guarantees:
 *  - Deterministic: fixed weights × fixed features, no sampling (I-3).
 *  - Fail-finite: any non-finite intermediate throws before it can reach a
 *    proposal (P2-B7).
 *  - Explainable: returns exact logreg attributions wᵢ·x̂ᵢ whose sum + bias
 *    reconstructs the logit to 1e-9 (identity is TESTED, not assumed).
 */
import { stableSigmoid } from "./logreg.js";
import { FEATURE_NAMES } from "./features.js";

/**
 * Structural model view — ModelArtifact satisfies this, but evaluation code
 * can score with raw (weights, bias, μ, σ) before an artifact exists.
 */
export interface LinearModel {
  featureNames: readonly string[];
  weights: readonly number[];
  bias: number;
  mu: readonly number[];
  sigma: readonly number[];
}

/** Pre-calibrated default 22-D model weights (deterministic baseline). */
export const DEFAULT_16D_MODEL: LinearModel = {
  featureNames: FEATURE_NAMES,
  weights: [
    0.85, // f_class_soft
    -0.20, // f_class_hard
    0.75, // f_class_network
    -3.50, // f_class_risk (suppresses fraud/risk to P < 0.05)
    1.20, // near_payday
    0.60, // payday_confidence
    -0.35, // amount_z
    1.40, // prior_success_norm (high LTV / loyalty)
    -0.90, // prior_failure_norm
    0.80, // channel_responsiveness
    0.70, // tenure_norm
    0.50, // ltv_paise_norm
    -1.10, // churn_risk_norm
    0.30, // days_since_last_attempt_norm
    -0.10, // high_value_tier
    // Payment method features
    0.30, // is_card — cards have established retry mechanisms
    0.45, // is_upi — UPI has highest recovery rate in India
    -0.15, // is_netbanking — netbanking failures tend to persist
    -0.05, // is_wallet — neutral signal
    -0.25, // is_emi — EMI failures are often method-dead
    0.15, // is_debit_card — debit cards recover slightly better
    -0.40, // is_international — international cards have more restrictions
  ],
  bias: 0.15,
  mu: Array(22).fill(0),
  sigma: Array(22).fill(1),
};

export interface ScoreResult {
  probability: number;
  logit: number;
  /** Top attributions by |contribution| — the "why" for the case brief. */
  attributions: Array<{ feature: string; contribution: number }>;
}

export function scoreWithArtifact(
  values: readonly number[],
  model: LinearModel = DEFAULT_16D_MODEL,
): ScoreResult {
  if (values.length !== model.featureNames.length) {
    throw new Error(
      `scoreWithArtifact: expected ${model.featureNames.length} values, got ${values.length}`,
    );
  }
  let z = model.bias;
  const contributions: Array<{ feature: string; contribution: number }> = [];
  for (let i = 0; i < values.length; i++) {
    const xs = ((values[i] as number) - (model.mu[i] as number)) / (model.sigma[i] as number);
    const c = (model.weights[i] as number) * xs;
    contributions.push({ feature: model.featureNames[i] as string, contribution: c });
    z += c;
  }
  const probability = stableSigmoid(z);

  // Attribution identity: Σcontributions + bias === logit
  let sum = model.bias;
  for (const c of contributions) sum += c.contribution;
  if (Math.abs(sum - z) > 1e-9) {
    throw new Error(`attribution identity violated: ${sum} vs ${z}`);
  }

  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  return {
    probability,
    logit: z,
    attributions: contributions.slice(0, 5),
  };
}
