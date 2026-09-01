import { openDb, runMigrations } from "@arbiter/core/db";
import { executeAll, sweepStuckExecutions } from "@arbiter/core/executor";
import { formatINR, logger, paise } from "@arbiter/shared";

async function main(): Promise<void> {
  const t0 = Date.now();
  let nowMs = t0;
  const atIdx = process.argv.indexOf("--at");
  if (atIdx > 0) {
    const raw = process.argv[atIdx + 1];
    const parsed = raw ? Date.parse(raw) : Number.NaN;
    if (!Number.isFinite(parsed)) {
      logger.error({ msg: `execute: --at expects an ISO timestamp, got ${raw}` });
      process.exit(1);
    }
    nowMs = parsed;
  }
  logger.info({
    msg: `execute: running as of ${new Date(nowMs).toISOString()}${nowMs === t0 ? " (live clock)" : ""}`,
  });

  const { client } = await openDb(process.env.ARBITER_DB_PATH);
  const applied = await runMigrations(client);
  if (applied > 0) logger.info({ msg: `execute: applied ${applied} migration(s)` });

  // Sweep stale EXECUTING proposals first
  const swept = await sweepStuckExecutions(client, nowMs, 5);
  if (swept > 0) logger.info({ msg: `execute: swept ${swept} stale execution(s)` });

  // Execute all APPROVED / AUTO_APPROVED proposals
  const result = await executeAll(client, nowMs);
  logger.info({
    msg: `execute: ${result.executed} executed · ${result.succeeded} succeeded · ${result.failed} failed · ${result.ambiguous} ambiguous`,
  });

  if (result.errors.length > 0) {
    logger.error({ msg: "execute errors:" });
    for (const e of result.errors) logger.error({ msg: e });
  }

  // Show terminal state counts
  const terminal = await client.execute({
    sql: `SELECT state, count(*) n FROM proposals
          WHERE state IN ('EXECUTED','FAILED')
          GROUP BY state ORDER BY state`,
  });
  logger.info({ msg: "\nTerminal states:" });
  for (const row of terminal.rows) {
    logger.info({ msg: `  ${String(row.state).padEnd(10)} ${String(row.n).padStart(6)}` });
  }
}

main().catch((err) => {
  logger.error({ msg: "execute failed:", err });
  process.exit(1);
});
