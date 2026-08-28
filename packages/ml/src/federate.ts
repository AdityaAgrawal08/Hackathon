/**
 * `pnpm federate` — Federated merchant intelligence demo.
 *
 * Simulates 4 merchant silos training locally, then runs FedAvg with DP noise
 * to produce a global model. Promotes it as INCUMBENT and prints provenance.
 */
import { openDb, runMigrations } from "@arbiter/core/db";
import { simulateFederatedTraining, promoteFederatedModel } from "./federation.js";
import { isoUtc } from "@arbiter/shared";

async function main(): Promise<void> {
  const nowMs = Date.now();
  console.log(`federate: running as of ${new Date(nowMs).toISOString()} (live clock)`);

  const { client } = await openDb(process.env.ARBITER_DB_PATH);
  const applied = await runMigrations(client);
  if (applied > 0) console.log(`federate: applied ${applied} migration(s)`);

  // Simulate 4 merchant silos (e.g., fintech, e-comm, marketplace, SaaS)
  const siloCount = 4;
  const dpNoiseScale = 0.01; // ε ≈ 1.0 approx for demo
  console.log(`federate: simulating ${siloCount} merchant silos with DP noise ${dpNoiseScale}`);

  const globalArtifact = await simulateFederatedTraining(siloCount, dpNoiseScale);

  // Promote as INCUMBENT
  await promoteFederatedModel(client, globalArtifact);

  // ── Report ──────────────────────────────────────────────────────
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  FEDERATED MODEL PROMOTED");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  Model ID           : ${globalArtifact.id}`);
  console.log(`  Feature dim        : ${globalArtifact.weights.length} (${globalArtifact.featureVersion})`);
  console.log(`  Silos aggregated   : 4`);
  console.log(`  DP noise scale     : ${dpNoiseScale}`);
  console.log(`  Global sample size : ${JSON.parse(globalArtifact.metricsJson).globalSampleCount}`);
  console.log(`  Bias               : ${globalArtifact.bias.toFixed(4)}`);
  const wSum = globalArtifact.weights.reduce((a, b) => a + Math.abs(b), 0);
  console.log(`  L1 weight norm     : ${wSum.toFixed(4)}`);
  console.log(`  Dataset SHA        : ${globalArtifact.datasetSha256}`);
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  No merchant PII left silo; only weight deltas + DP noise shared.");
  console.log("  Audit trail: federation provenance recorded in model registry.");
  console.log("══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("federate failed:", err);
  process.exit(1);
});