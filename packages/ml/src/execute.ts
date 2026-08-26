import { openDb, runMigrations } from "@arbiter/core/db";
import { executeAll, sweepStuckExecutions } from "@arbiter/core/executor";
import { formatINR, paise } from "@arbiter/shared";

async function main(): Promise<void> {
  const t0 = Date.now();
  let nowMs = t0;
  const atIdx = process.argv.indexOf("--at");
  if (atIdx > 0) {
    const raw = process.argv[atIdx + 1];
    const parsed = raw ? Date.parse(raw) : Number.NaN;
    if (!Number.isFinite(parsed)) {
      console.error(`execute: --at expects an ISO timestamp, got ${raw}`);
      process.exit(1);
    }
    nowMs = parsed;
  }
  console.log(
    `execute: running as of ${new Date(nowMs).toISOString()}${nowMs === t0 ? " (live clock)" : ""}`,
  );

  const { client } = await openDb(process.env.ARBITER_DB_PATH);
  const applied = await runMigrations(client);
  if (applied > 0) console.log(`execute: applied ${applied} migration(s)`);

  // Sweep stale EXECUTING proposals first
  const swept = await sweepStuckExecutions(client, nowMs, 5);
  if (swept > 0) console.log(`execute: swept ${swept} stale execution(s)`);

  // Execute all APPROVED / AUTO_APPROVED proposals
  const result = await executeAll(client, nowMs);
  console.log(
    `execute: ${result.executed} executed · ${result.succeeded} succeeded · ` +
      `${result.failed} failed · ${result.ambiguous} ambiguous`,
  );

  if (result.errors.length > 0) {
    console.error("execute errors:");
    for (const e of result.errors) console.error(`  ${e}`);
  }

  // Show terminal state counts
  const terminal = await client.execute({
    sql: `SELECT state, count(*) n FROM proposals
          WHERE state IN ('EXECUTED','FAILED')
          GROUP BY state ORDER BY state`,
  });
  console.log("\nTerminal states:");
  for (const row of terminal.rows) {
    console.log(`  ${String(row.state).padEnd(10)} ${String(row.n).padStart(6)}`);
  }
}

main().catch((err) => {
  console.error("execute failed:", err);
  process.exit(1);
});
