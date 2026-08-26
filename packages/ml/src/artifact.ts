/**
 * Model artifact — the immutable unit of intelligence (invariant I-3/I-4).
 * Everything needed to reproduce a decision ships inside: weights, bias,
 * standardization constants, feature list + version. sha256 over canonical
 * JSON gives decisions a permanent address in history.
 */
import { createHash } from "node:crypto";
import { FEATURE_VERSION, FEATURE_NAMES } from "./features.js";

export interface ModelArtifact {
  id: string; // "logreg@0.1.0+<sha8>"
  kind: "logreg";
  featureVersion: string;
  featureNames: readonly string[];
  weights: number[];
  bias: number;
  mu: number[];
  sigma: number[];
  metricsJson: string; // serialized metrics snapshot (AUC/Brier/calibration/counts)
  datasetSha256: string;
  weightsSha256: string;
  trainedAtUtc: string;
}

/** Canonical JSON: recursively sorted object keys — hash stability across runs. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function artifactWeightsSha(a: Omit<ModelArtifact, "weightsSha256" | "id">): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        featureVersion: a.featureVersion,
        featureNames: [...a.featureNames],
        weights: a.weights,
        bias: a.bias,
        mu: a.mu,
        sigma: a.sigma,
      }),
    )
    .digest("hex");
}

export function buildArtifact(args: {
  weights: number[];
  bias: number;
  mu: number[];
  sigma: number[];
  metricsJson: string;
  datasetSha256: string;
  trainedAtUtc: string;
}): ModelArtifact {
  const base = {
    kind: "logreg" as const,
    featureVersion: FEATURE_VERSION,
    featureNames: FEATURE_NAMES,
    weights: args.weights,
    bias: args.bias,
    mu: args.mu,
    sigma: args.sigma,
    metricsJson: args.metricsJson,
    datasetSha256: args.datasetSha256,
    trainedAtUtc: args.trainedAtUtc,
  };
  const weightsSha = artifactWeightsSha(base);
  const shortId = weightsSha.slice(0, 8);
  return { ...base, weightsSha256: weightsSha, id: `logreg@0.1.0+${shortId}`, kind: "logreg" };
}
