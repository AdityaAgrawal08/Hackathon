import { generateCorpus } from "@arbiter/seed/generate";
import { openDb, runMigrations } from "@arbiter/core/db";
import { replayCorpus } from "@arbiter/core/ingest";
import { loadPolicyFile, resolvePolicyPath } from "@arbiter/core/decide";
import { formatINR, logger, paise } from "@arbiter/shared";
import { getIncumbent } from "./registry.js";
import { proposeForCorpus } from "./pipeline.js";

async function main(): Promise<void> {
  const t0 = Date.now();
  let nowMs = t0;
  const atIdx = process.argv.indexOf("--at");
  if (atIdx > 0) {
    const raw = process.argv[atIdx + 1];
    const parsed = raw ? Date.parse(raw) : Number.NaN;
    if (!Number.isFinite(parsed)) {
      logger.error({ msg: `propose: --at expects an ISO timestamp, got ${raw}` });
      process.exit(1);
    }
    nowMs = parsed;
  }
  logger.info({ msg: `propose: deciding as of ${new Date(nowMs).toISOString()}${nowMs === t0 ? " (live clock)" : ""}` });

  const policy = loadPolicyFile(resolvePolicyPath());
  logger.info({ msg: `propose: policy ${policy.policy_version} loaded` });

  const corpus = generateCorpus("demo", { customerCount: 60, targetEvents: 230 });

  const { client } = await openDb(process.env.ARBITER_DB_PATH);
  const applied = await runMigrations(client);
  if (applied > 0) logger.info({ msg: `propose: applied ${applied} migration(s)` });

  const replay = await replayCorpus(client, corpus);
  logger.info({ msg: `propose: demo corpus present (${replay.events} new events, ${replay.duplicates} existing)` });

  const model = await getIncumbent(client);
  if (!model) {
    logger.error({ msg: "propose: no INCUMBENT model — run `pnpm train` first" });
    process.exit(1);
  }
  logger.info({ msg: `propose: scoring with ${model.id}` });

  const summary = await proposeForCorpus(client, { policy, model, nowMs });
  logger.info({
    msg: `propose: ${summary.proposed} proposed · ${summary.duplicates} duplicates · ${summary.skippedOpenProposal} waiting (open proposal) · ${summary.skippedUnresolved} unresolved customers`,
  });

  const queue = await client.execute({
    sql: `SELECT p.id, p.event_id, p.ev_paise, p.confidence, p.action_json,
                 e.failure_code, e.amount_paise
          FROM proposals p JOIN payment_events e ON e.id = p.event_id
          WHERE p.state = 'AWAITING_APPROVAL'
          ORDER BY p.ev_paise DESC, p.id ASC
          LIMIT 10`,
  });

  logger.info({ msg: "Top of the approval queue:" });
  for (const row of queue.rows) {
    const action = JSON.parse(String(row.action_json)) as { action: string };
    const pct = (Number(row.confidence) * 100).toFixed(1).padStart(4);
    const ev = formatINR(paise(Number(row.ev_paise)));
    logger.info({
      msg: `  ${String(row.event_id)}  ${String(row.failure_code).padEnd(20)} p=${pct}%  EV=${ev.padStart(12)}  → ${action.action}`,
    });
  }
}

main().catch((err) => {
  logger.error({ msg: "propose failed:", err });
  process.exit(1);
});
