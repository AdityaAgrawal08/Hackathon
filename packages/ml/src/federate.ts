/**
 * `pnpm federate` — Federated merchant intelligence demo.
 *
 * Simulates 4 merchant silos training locally, then runs FedAvg with DP noise
 * to produce a global model. Promotes it as INCUMBENT and prints provenance.
 */
import { openDb, runMigrations } from "@arbiter/core/db";
import { logger } from "@arbiter/shared";
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
  logger.info({ msg: `federate: running at fixed epoch ${new Date(nowMs).toISOString()} (reproducible)` });

  const { client } = await openDb(process.env.ARBITER_DB_PATH);
  const applied = await runMigrations(client);
  if (applied > 0) logger.info({ msg: `federate: applied ${applied} migration(s)` });

  // Simulate N distinct merchant silos (≥2 required to be a real federation).
  const siloCount = Math.max(2, SILO_NAMES.length);
  const dpNoiseScale = 0.01; // ε ≈ 1.0 approx for demo
  logger.info({
    msg: `federate: simulating ${siloCount} merchant silos [${SILO_NAMES.slice(0, siloCount).join(", ")}] with DP noise ${dpNoiseScale}`,
  });

  const globalArtifact = await simulateFederatedTraining(siloCount, dpNoiseScale, nowMs);

  // Promote as INCUMBENT (writes federation audit trail).
  await promoteFederatedModel(client, globalArtifact);

  // ── Report ──────────────────────────────────────────────────────
  const metrics = JSON.parse(globalArtifact.metricsJson) as {
    siloCount: number;
    globalSampleCount: number;
    dpNoiseScale: number;
  };
  logger.info({ msg: "══════════════════════════════════════════════════════════════" });
  logger.info({ msg: "  FEDERATED MODEL PROMOTED" });
  logger.info({ msg: "══════════════════════════════════════════════════════════════" });
  logger.info({ msg: `  Model ID           : ${globalArtifact.id}` });
  logger.info({ msg: `  Feature dim        : ${globalArtifact.weights.length} (${globalArtifact.featureVersion})` });
  logger.info({ msg: `  Silos aggregated   : ${metrics.siloCount}` });
  logger.info({ msg: `  DP noise scale     : ${metrics.dpNoiseScale}` });
  logger.info({ msg: `  Global sample size : ${metrics.globalSampleCount}` });
  logger.info({ msg: `  Bias               : ${globalArtifact.bias.toFixed(4)}` });
  const wSum = globalArtifact.weights.reduce((a, b) => a + Math.abs(b), 0);
  logger.info({ msg: `  L1 weight norm     : ${wSum.toFixed(4)}` });
  logger.info({ msg: `  Dataset SHA        : ${globalArtifact.datasetSha256}` });
  logger.info({ msg: "══════════════════════════════════════════════════════════════" });
  logger.info({ msg: "  No merchant PII left silo; only weight deltas + DP noise shared." });
  logger.info({ msg: "  Audit trail: federation provenance recorded in model registry + audit_log." });
  logger.info({ msg: "══════════════════════════════════════════════════════════════" });
}

main().catch((err) => {
  logger.error({ msg: "federate failed", err });
  process.exit(1);
});