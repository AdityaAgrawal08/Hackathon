/**
 * `pnpm train` — P2 entrypoint.
 *
 * Deterministic end-to-end:
 *   1. generate TRAINING corpus in-process (same generator as the fixtures —
 *      byte-identical, no file dependency),
 *   2. ingest it into the DB via the replay path (idempotent),
 *   3. compute + freeze feature vectors,
 *   4. train (customer-disjoint split), evaluate HOLDOUT-only,
 *   5. publish the immutable artifact as INCUMBENT model version.
 *
 * Running twice yields the same weightsSha256; only provenance timestamps
 * differ (they are metadata, never decision inputs).
 */
import { generateCorpus } from "@arbiter/seed/generate";
import { openDb, runMigrations } from "@arbiter/core/db";
import { replayCorpus } from "@arbiter/core/ingest";
import { buildTrainingDataset } from "./dataset.js";
import { saveFeatures } from "./features_store.js";
import { trainAndEvaluate } from "./train.js";
import { saveModel } from "./registry.js";
import { isoUtc, logger } from "@arbiter/shared";

async function main(): Promise<void> {
  const t0 = Date.now();
  logger.info({ msg: "train: generating deterministic TRAINING corpus" });
  const corpus = generateCorpus("training", { customerCount: 1200, targetEvents: 5000 });
  logger.info({ msg: "train: customers and events generated", customerCount: corpus.meta.customerCount, eventCount: corpus.meta.eventCount });

  // ── DB: migrate → ingest → freeze features
  const { client } = await openDb(process.env.ARBITER_DB_PATH);
  const applied = await runMigrations(client);
  if (applied > 0) logger.info({ msg: "train: migrations applied", applied });

  const replay = await replayCorpus(client, corpus);
  logger.info({ msg: "train: ingested", events: replay.events, duplicates: replay.duplicates });

  const dataset = buildTrainingDataset(corpus);
  if (dataset.skipped > 0) {
    throw new Error(`train: ${dataset.skipped} truth-less rows in TRAINING corpus`);
  }
  const frozen = await saveFeatures(
    client,
    dataset.rows.map((r) => ({ eventId: r.eventId, values: r.values })),
    t0,
  );
  logger.info({ msg: "train: features frozen", inserted: frozen.inserted, unchanged: frozen.unchanged });

  // ── Fit + evaluate
  const { artifact, report } = trainAndEvaluate(corpus);
  const stamped = { ...artifact, trainedAtUtc: isoUtc(Date.now()) };

  await saveModel(client, stamped, "INCUMBENT");
  logger.info({ msg: "train: published model", modelId: stamped.id, version: "INCUMBENT" });

  // ── Report
  const topW = stamped.weights
    .map((w, i) => ({ f: stamped.featureNames[i] as string, w }))
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
    .slice(0, 5);
  logger.info({
    msg: "P2 training report",
    modelId: stamped.id,
    weightsSha256: stamped.weightsSha256,
    datasetSha256: stamped.datasetSha256,
    trainRows: report.counts.trainRows,
    holdoutRows: report.counts.holdoutRows,
    trainCustomers: report.counts.trainCustomers,
    holdoutCustomers: report.counts.holdoutCustomers,
    auc: report.auc,
    brier: report.brier,
    calibration: report.calibration
      .filter((b) => b.count > 0)
      .map((b) => `bin${b.bin}:${b.empiricalRate.toFixed(2)}/${b.meanPredicted.toFixed(2)}×${b.count}`)
      .join("  "),
    perClass: report.perClass
      .map(
        (c) =>
          `  ${c.failureClass.padEnd(18)} n=${String(c.n).padStart(4)}  pos=${String(c.positives).padStart(4)}  recall=${c.recall === null ? "n/a" : c.recall.toFixed(3)}  meanScore=${c.meanScore.toFixed(3)}`,
      )
      .join("\n"),
    topWeights: topW.map((x) => `${x.f}=${x.w.toFixed(3)}`).join("  "),
    gateCheck: report.auc >= 0.75,
  });
}

main().catch((err) => {
  logger.error({ msg: "train failed", error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  process.exit(1);
});
