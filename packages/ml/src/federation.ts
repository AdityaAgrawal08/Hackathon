/**
 * Federated Merchant Intelligence — FedAvg with Differential Privacy.
 *
 * The moat: a single PSP *cannot* mix merchant data (competitive/regulatory).
 * A neutral federated layer enables collective failure-pattern learning
 * without moving PII or competitor-sensitive data.
 *
 * Flow (simulated for demo):
 *   1. Each "merchant silo" trains a local model on its own corpus.
 *   2. Silos send weight *deltas* (not raw data) to the coordinator.
 *   3. Coordinator computes FedAvg + adds Gaussian DP noise.
 *   4. Global model is promoted as new incumbent via registry.
 *   5. Audit trail records: silo count, DP noise scale, aggregation hash.
 *
 * References:
 *   - NVIDIA FLARE FL for payments (2026): AUROC 0.903 vs 0.925 centralized
 *   - JPMorgan/RBC/BNY/Mastercard/Stripe integrating FL (arxiv:2603.13617)
 */
import type { Client } from "@libsql/client";
import type { ModelArtifact } from "./artifact.js";
import { FEATURE_COUNT } from "./features.js";
import { promoteFederated } from "./registry.js";
import { hashSeed, isoUtc, Rng } from "@arbiter/shared";

export interface SiloReport {
  siloId: string;
  weights: number[];
  bias: number;
  sampleCount: number;
  trainedAtUtc: string;
}

/** A fixed, deterministic epoch used as the default training clock so the
 *  simulated federation is byte-reproducible (bug #11: Date.now() broke this). */
export const FEDERATION_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

/** Box-Muller transform for N(0, scale²) using an injected deterministic RNG. */
function dpNoise(scale: number, rng: () => number): number {
  // Guard against log(0) — consume two uniforms.
  const u1 = Math.max(Number.EPSILON, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * scale;
}

/**
 * Deterministic seed for the DP-noise stream: derived from the silo weights
 * themselves (not the wall clock) so identical inputs reproduce identical noise
 * (bug #10: Math.random() made the demo non-reproducible).
 */
function dpNoiseSeed(silos: SiloReport[], dpNoiseScale: number): number {
  const fingerprint = silos
    .map((s) => `${s.siloId}:${s.weights.join(",")}:${s.bias}:${s.sampleCount}`)
    .join("|") + `#${dpNoiseScale}`;
  return hashSeed(`fed-dp:${fingerprint}`);
}

/** Default DP-noise RNG: seeded from silo contents so runs are reproducible. */
function defaultDpRng(silos: SiloReport[], dpNoiseScale: number): () => number {
  const r = new Rng(dpNoiseSeed(silos, dpNoiseScale));
  return () => r.next();
}

/**
 * Federated Averaging (FedAvg) with optional DP noise.
 * All silos must have identical feature dimensions.
 *
 * Determinism (bug #10/#11): DP noise draws from a deterministic RNG seeded by
 * the silo contents; pass `rng` to fully control the stream (e.g. in tests).
 */
export function federatedAverage(
  silos: SiloReport[],
  dpNoiseScale = 0,
  rng: () => number = defaultDpRng(silos, dpNoiseScale),
): { weights: number[]; bias: number; globalSampleCount: number } {
  if (silos.length === 0) throw new Error("federatedAverage: no silos");
  const dim = FEATURE_COUNT;
  for (const s of silos) {
    if (s.weights.length !== dim) {
      throw new Error(`federatedAverage: silo ${s.siloId} dim ${s.weights.length} ≠ ${dim}`);
    }
  }

  const totalSamples: number = silos.reduce((sum, s) => sum + s.sampleCount, 0);
  const weights = new Array(dim).fill(0);
  let bias = 0;

  for (const s of silos) {
    const w = s.sampleCount / (totalSamples || 1);
    for (let i = 0; i < dim; i++) weights[i] += s.weights[i]! * w;
    bias += s.bias * w;
  }

  // Add DP noise to weights + bias (simplified: same scale for all)
  if (dpNoiseScale > 0) {
    for (let i = 0; i < dim; i++) weights[i] += dpNoise(dpNoiseScale, rng);
    bias += dpNoise(dpNoiseScale, rng);
  }

  return { weights, bias, globalSampleCount: totalSamples };
}

/**
 * Simulate multiple merchant silos training on local corpora.
 * In production, each silo runs `trainAndEvaluate` locally and submits deltas.
 *
 * Determinism (bug #11/#41): `nowMs` defaults to a fixed epoch; each silo gets
 * a +i-second offset so timestamps differ yet stay reproducible.
 */
export async function simulateFederatedTraining(
  siloCount: number,
  dpNoiseScale = 0.01,
  nowMs: number = FEDERATION_EPOCH_MS,
): Promise<ModelArtifact> {
  if (!Number.isInteger(siloCount) || siloCount < 1) {
    throw new Error(`simulateFederatedTraining: bad siloCount ${siloCount}`);
  }
  const silos: SiloReport[] = [];
  for (let i = 0; i < siloCount; i++) {
    // Simulate local training by generating a random but deterministic artifact
    // (seeded per silo so the demo is reproducible).
    const seed = `federated-silo-${i}`;
    const rng = new Rng(hashSeed(seed));
    const weights = Array.from({ length: FEATURE_COUNT }, () => (rng.next() - 0.5) * 0.2);
    const bias = (rng.next() - 0.5) * 0.5;
    const sampleCount = Math.round(1000 + rng.next() * 2000); // 1k-3k per silo
    // Bug #41: distinct, reproducible timestamp per silo (+i seconds).
    silos.push({
      siloId: `silo-${i}`,
      weights,
      bias,
      sampleCount,
      trainedAtUtc: isoUtc(nowMs + i * 1000),
    });
  }

  const { weights, bias, globalSampleCount } = federatedAverage(silos, dpNoiseScale);

  const artifact: ModelArtifact = {
    id: `federated@${hashSeed(`fed:${siloCount}:${dpNoiseScale}:${nowMs}`)}`,
    kind: "logreg",
    featureVersion: "feat-v1",
    featureNames: Array.from({ length: FEATURE_COUNT }, (_, i) => `f_${i}`),
    weights,
    bias,
    mu: Array(FEATURE_COUNT).fill(0),
    sigma: Array(FEATURE_COUNT).fill(1),
    metricsJson: JSON.stringify({ siloCount, globalSampleCount, dpNoiseScale }),
    datasetSha256: `federated-${siloCount}-silos`,
    weightsSha256: "",
    trainedAtUtc: isoUtc(nowMs),
  };
  return artifact;
}

/**
 * Promote a federated model to INCUMBENT in the registry with an audit trail.
 * Delegates to registry.promoteFederated (single source of truth for promotion).
 */
export async function promoteFederatedModel(
  client: Client,
  artifact: ModelArtifact,
): Promise<void> {
  await promoteFederated(client, artifact);
}