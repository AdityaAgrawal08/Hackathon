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
import { isoUtc } from "@arbiter/shared";

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log("train: generating deterministic TRAINING corpus…");
  const corpus = generateCorpus("training", { customerCount: 1200, targetEvents: 5000 });
  console.log(
    `train: ${corpus.meta.customerCount} customers, ${corpus.meta.eventCount} events`,
  );

  // ── DB: migrate → ingest → freeze features
  const { client } = await openDb(process.env.ARBITER_DB_PATH);
  const applied = await runMigrations(client);
  if (applied > 0) console.log(`train: applied ${applied} migration(s)`);

  const replay = await replayCorpus(client, corpus);
  console.log(
    `train: ingested ${replay.events} events (${replay.duplicates} already present)`,
  );

  const dataset = buildTrainingDataset(corpus);
  if (dataset.skipped > 0) {
    throw new Error(`train: ${dataset.skipped} truth-less rows in TRAINING corpus`);
  }
  const frozen = await saveFeatures(
    client,
    dataset.rows.map((r) => ({ eventId: r.eventId, values: r.values })),
    t0,
  );
  console.log(
    `train: features frozen (${frozen.inserted} written, ${frozen.unchanged} unchanged)`,
  );

  // ── Fit + evaluate
  const { artifact, report } = trainAndEvaluate(corpus);
  const stamped = { ...artifact, trainedAtUtc: isoUtc(Date.now()) };

  await saveModel(client, stamped, "INCUMBENT");
  console.log(`train: published ${stamped.id} (INCUMBENT)`);

  // ── Report
  const topW = stamped.weights
    .map((w, i) => ({ f: stamped.featureNames[i] as string, w }))
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
    .slice(0, 5);
  console.log(`
── P2 training report ─────────────────────────────
model id        : ${stamped.id}
weights sha256  : ${stamped.weightsSha256}
dataset sha256  : ${stamped.datasetSha256}
split           : ${report.counts.trainRows} train / ${report.counts.holdoutRows} holdout
                  (${report.counts.trainCustomers} / ${report.counts.holdoutCustomers} customers — disjoint)
AUC (holdout)   : ${report.auc.toFixed(4)}
Brier (holdout) : ${report.brier.toFixed(4)}
calibration     : ${report.calibration
    .filter((b) => b.count > 0)
    .map((b) => `bin${b.bin}:${b.empiricalRate.toFixed(2)}/${b.meanPredicted.toFixed(2)}×${b.count}`)
    .join("  ")}
per-class recall:
${report.perClass
  .map(
    (c) =>
      `  ${c.failureClass.padEnd(18)} n=${String(c.n).padStart(4)}  pos=${String(c.positives).padStart(4)}  recall=${c.recall === null ? "n/a" : c.recall.toFixed(3)}  meanScore=${c.meanScore.toFixed(3)}`,
  )
  .join("\n")}
top weights     : ${topW.map((x) => `${x.f}=${x.w.toFixed(3)}`).join("  ")}

Gate check      : AUC ${report.auc >= 0.75 ? "≥ 0.75 ✓" : "< 0.75 ✗ (investigate before proceeding)"}
───────────────────────────────────────────────────`);
}

main().catch((err) => {
  console.error("train failed:", err);
  process.exit(1);
});
