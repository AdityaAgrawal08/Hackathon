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

export interface ScoreResult {
  probability: number;
  logit: number;
  /** Top attributions by |contribution| — the "why" for the case brief. */
  attributions: Array<{ feature: string; contribution: number }>;
}

export function scoreWithArtifact(
  values: readonly number[],
  model: LinearModel,
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
