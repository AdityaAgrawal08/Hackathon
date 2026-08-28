/**
 * `pnpm recover` — Track 3 demo: measured money recovered across a batch.
 *
 * End-to-end: ingest a demo batch of failed payments → detect → diagnose →
 * decide → execute the bounded recovery workflow → report MEASURED recovery ₹
 * with compliant escalation, stopping rules, and audit-trail counts.
 */
import { generateCorpus } from "@arbiter/seed/generate";
import { openDb, runMigrations } from "@arbiter/core/db";
import { replayCorpus } from "@arbiter/core/ingest";
import { loadPolicyFile, resolvePolicyPath } from "@arbiter/core/decide";
import { isoUtc, formatINR, paise } from "@arbiter/shared";
import { trainAndEvaluate } from "./train.js";
import { getIncumbent, saveModel } from "./registry.js";
import { buildArtifact, type ModelArtifact } from "./artifact.js";
import { FEATURE_NAMES } from "./features.js";
import { recoverBatch } from "./recovery.js";

async function main(): Promise<void> {
  const nowMs = Date.now();
  console.log(`recover: running as of ${new Date(nowMs).toISOString()} (live clock)`);

  const policy = loadPolicyFile(resolvePolicyPath());
  console.log(`recover: policy ${policy.policy_version} loaded`);

  const corpus = generateCorpus("demo", { customerCount: 60, targetEvents: 230 });

  const { client } = await openDb(process.env.ARBITER_DB_PATH);
  const applied = await runMigrations(client);
  if (applied > 0) console.log(`recover: applied ${applied} migration(s)`);

  const replay = await replayCorpus(client, corpus);
  console.log(`recover: ${replay.events} failure events ingested`);

  // Apply a demo autonomy envelope: auto-approve most recovery classes but
  // route RISK_FLAGGED to human review (compliant escalation).
  await client.execute({
    sql: `UPDATE tenants SET autonomy_envelope_json = ? WHERE id = 'demo'`,
    args: [
      JSON.stringify({
        envelope_version: "env-v1",
        enabled: true,
        classes: ["SOFT_RETRYABLE", "HARD_METHOD_DEAD", "NETWORK_TIMEOUT"],
        channels: ["RETRY_NOW", "RETRY_PAYDAY", "ALTERNATE_UPI_LINK", "REMINDER_LINK"],
        max_attempts: 3,
        max_amount_paise: 1_00_00_000,
        require_quiet_ok: false,
      }),
    ],
  });

  // Ensure an incumbent model exists (train one if labeled data is present;
  // otherwise fall back to a default heuristic incumbent so the demo is runnable).
  const incumbent = await getIncumbent(client);
  let model: ModelArtifact;
  if (incumbent) {
    model = incumbent;
    console.log(`recover: scoring with ${model.id}`);
  } else {
    try {
      const { artifact } = trainAndEvaluate(corpus);
      const stamped = { ...artifact, trainedAtUtc: isoUtc(nowMs) };
      await saveModel(client, stamped, "INCUMBENT");
      model = stamped;
      console.log(`recover: trained ${model.id} (INCUMBENT)`);
    } catch (err) {
      console.warn(
        `recover: training skipped (${(err as Error).message}); using default heuristic model`,
      );
      const heuristic = buildArtifact({
        weights: FEATURE_NAMES.map(() => 0.08),
        bias: -1.2,
        mu: FEATURE_NAMES.map(() => 0),
        sigma: FEATURE_NAMES.map(() => 1),
        metricsJson: "{}",
        datasetSha256: "default-heuristic",
        trainedAtUtc: isoUtc(nowMs),
      });
      await saveModel(client, heuristic, "INCUMBENT");
      model = heuristic;
      console.log(`recover: loaded default heuristic ${model.id} (INCUMBENT)`);
    }
  }

  // Collect the batch of at-risk events.
  const ids = await client.execute({
    sql: `SELECT id FROM payment_events WHERE source IN ('SEED', 'WEBHOOK') ORDER BY occurred_at_utc ASC, id ASC`,
  });
  const eventIds = ids.rows.map((r) => String(r.id));
  console.log(`recover: batch size = ${eventIds.length} at-risk events\n`);

  // Run the bounded recovery loop and MEASURE.
  const report = await recoverBatch(client, eventIds, { nowMs, batchId: `demo_${nowMs}` });

  // ── Report (the bar: measured money recovered across a batch) ──
  const pct = report.totalAtRiskPaise > 0
    ? ((report.recoveredPaise / report.totalAtRiskPaise) * 100).toFixed(1)
    : "0.0";
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  BATCH RECOVERY REPORT");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  Batch ID            : ${report.batchId}`);
  console.log(`  Events in batch     : ${report.eventCount}`);
  console.log(`  Processed / skipped : ${report.processedCount} / ${report.skippedCount}`);
  console.log("");
  console.log(`  At-risk revenue     : ${formatINR(paise(report.totalAtRiskPaise))}`);
  console.log(`  RECOVERED (meas.)   : ${formatINR(paise(report.recoveredPaise))}  (${pct}%)`);
  console.log(`  Escalated (human)   : ${formatINR(paise(report.escalatedPaise))}  [${report.humanEscalations} esc.]`);
  console.log(`  Stopped (policy)    : ${formatINR(paise(report.stoppedPaise))}`);
  console.log("");
  console.log(`  Contacts made       : ${report.contactsMade}`);
  console.log(`  Wasted attempts     : ${report.wastedAttempts}  (stopping rules)`);
  console.log(`  Policy refusals     : ${report.policyRefusals}`);
  console.log(`  Audit-trail entries : ${report.auditTrailCount}  (DECISION + DIAGNOSIS per event)`);
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  Compliant escalation: HUMAN_REVIEW routed to human, never auto-approved");
  console.log("  Stopping rules      : envelope attempt/amount caps + quiet hours enforced");
  console.log("  Audit trail         : every detect/diagnose/decide/execute step logged");
  console.log("══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("recover failed:", err);
  process.exit(1);
});
