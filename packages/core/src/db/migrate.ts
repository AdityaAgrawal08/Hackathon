/**
 * Migration runner — applies drizzle-kit generated SQL in order, tracked in
 * a local table. Bug P1-B5 prevention: migrations are generated artifacts,
 * never hand-edited; runner is idempotent.
 */
import { createClient, type Client } from "@libsql/client";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DB_PATH, SQLITE_BUSY_TIMEOUT_MS } from "../constants.js";

export const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

export async function runMigrations(
  client: Client,
  migrationsDir: string = MIGRATIONS_DIR,
): Promise<number> {
  const isRemote = (process.env.ARBITER_DB_PATH || "").startsWith("libsql:") ||
                   (process.env.ARBITER_DB_PATH || "").startsWith("http:") ||
                   (process.env.ARBITER_DB_PATH || "").startsWith("https:");

  if (isRemote) {
    await client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at_utc TEXT NOT NULL
      );
    `);
  } else {
    await client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at_utc TEXT NOT NULL
      );
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS};
      PRAGMA foreign_keys=ON;
    `);
  }

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
    let sqlText = readFileSync(join(migrationsDir, f), "utf8");
    if (isRemote) {
      // Strip out PRAGMA lines because Turso/libSQL does not support them and will throw HTTP 400
      sqlText = sqlText
        .split("\n")
        .filter((line) => !line.trim().toUpperCase().startsWith("PRAGMA"))
        .join("\n");
    }
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
  const dbPath = process.env.ARBITER_DB_PATH ?? DEFAULT_DB_PATH;
  const url = (dbPath.startsWith("libsql:") || dbPath.startsWith("http:") || dbPath.startsWith("https:") || dbPath.startsWith("file:"))
    ? dbPath
    : `file:${resolve(dbPath)}`;
  if (!url.startsWith("libsql:") && !url.startsWith("http:") && !url.startsWith("https:") && !url.includes(":memory:")) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  }

  const client = createClient({
    url,
    authToken: process.env.ARBITER_DB_TOKEN,
  });
  console.log(`Running migrations against database...`);
  try {
    const count = await runMigrations(client);
    console.log(`Applied ${count} migrations successfully.`);
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  }
}

// CLI entry — skipped when imported by tests
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error("migrate failed:", err);
    process.exit(1);
  });
}
