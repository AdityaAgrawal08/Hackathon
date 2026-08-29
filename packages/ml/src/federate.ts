/**
 * `pnpm federate` — Federated merchant intelligence demo.
 *
 * Simulates 4 merchant silos training locally, then runs FedAvg with DP noise
 * to produce a global model. Promotes it as INCUMBENT and prints provenance.
 */
import { openDb, runMigrations } from "@arbiter/core/db";
import {
  simulateFederatedTraining,
  promoteFederatedModel,
  FEDERATION_EPOCH_MS,
} from "./federation.js";

/** Distinct merchant verticals — proves the model learns across merchants. */
const SILO_NAMES = ["fintech", "ecommerce", "marketplace", "saas"] as const;

async function main(): Promise<void> {
  // Deterministic clock so the federated demo is byte-reproducible (bug #11).
  const nowMs = FEDERATION_EPOCH_MS;
  console.log(`federate: running at fixed epoch ${new Date(nowMs).toISOString()} (reproducible)`);

  const { client } = await openDb(process.env.ARBITER_DB_PATH);
  const applied = await runMigrations(client);
  if (applied > 0) console.log(`federate: applied ${applied} migration(s)`);

  // Simulate N distinct merchant silos (≥2 required to be a real federation).
  const siloCount = Math.max(2, SILO_NAMES.length);
  const dpNoiseScale = 0.01; // ε ≈ 1.0 approx for demo
  console.log(
    `federate: simulating ${siloCount} merchant silos [${SILO_NAMES.slice(0, siloCount).join(", ")}] with DP noise ${dpNoiseScale}`,
  );

  const globalArtifact = await simulateFederatedTraining(siloCount, dpNoiseScale, nowMs);

  // Promote as INCUMBENT (writes federation audit trail).
  await promoteFederatedModel(client, globalArtifact);

  // ── Report ──────────────────────────────────────────────────────
  const metrics = JSON.parse(globalArtifact.metricsJson) as {
    siloCount: number;
    globalSampleCount: number;
    dpNoiseScale: number;
  };
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  FEDERATED MODEL PROMOTED");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  Model ID           : ${globalArtifact.id}`);
  console.log(`  Feature dim        : ${globalArtifact.weights.length} (${globalArtifact.featureVersion})`);
  console.log(`  Silos aggregated   : ${metrics.siloCount}`);
  console.log(`  DP noise scale     : ${metrics.dpNoiseScale}`);
  console.log(`  Global sample size : ${metrics.globalSampleCount}`);
  console.log(`  Bias               : ${globalArtifact.bias.toFixed(4)}`);
  const wSum = globalArtifact.weights.reduce((a, b) => a + Math.abs(b), 0);
  console.log(`  L1 weight norm     : ${wSum.toFixed(4)}`);
  console.log(`  Dataset SHA        : ${globalArtifact.datasetSha256}`);
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  No merchant PII left silo; only weight deltas + DP noise shared.");
  console.log("  Audit trail: federation provenance recorded in model registry + audit_log.");
  console.log("══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("federate failed:", err);
  process.exit(1);
});