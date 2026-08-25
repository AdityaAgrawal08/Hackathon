/**
 * Migration runner — applies drizzle-kit generated SQL in order, tracked in
 * a local table. Bug P1-B5 prevention: migrations are generated artifacts,
 * never hand-edited; runner is idempotent.
 */
import { createClient, type Client } from "@libsql/client";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

export async function runMigrations(
  client: Client,
  migrationsDir: string = MIGRATIONS_DIR,
): Promise<number> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at_utc TEXT NOT NULL
    );
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    PRAGMA foreign_keys=ON;
  `);

  const files = existsSync(migrationsDir)
    ? readdirSync(migrationsDir)
        .filter((f) => f.endsWith(".sql"))
        .sort()
    : [];

  let appliedCount = 0;
  for (const f of files) {
    const applied = await client.execute({
      sql: "SELECT 1 FROM schema_migrations WHERE name = ?",
      args: [f],
    });
    if (applied.rows.length > 0) continue;
    const sqlText = readFileSync(join(migrationsDir, f), "utf8");
    await client.executeMultiple(sqlText);
    await client.execute({
      sql: "INSERT INTO schema_migrations (name, applied_at_utc) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      args: [f],
    });
    appliedCount++;
  }
  return appliedCount;
}

async function main() {
  const dbPath = process.env.ARBITER_DB_PATH ?? "./data/arbiter.sqlite";
  const url = dbPath.startsWith("file:") ? dbPath : `file:${resolve(dbPath)}`;
  if (!url.includes(":memory:")) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  }
  const client = createClient({ url });
  const n = await runMigrations(client);
  console.log(`migrate: ${n} migration(s) applied`);
}

// CLI entry — skipped when imported by tests
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  main().catch((err) => {
    console.error("migrate failed:", err);
    process.exit(1);
  });
}
