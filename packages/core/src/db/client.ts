import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Open the ARBITER database.
 * Invariant I-6/I-5 live in column conventions; here we enforce connection-level
 * safety: WAL for concurrent readers (P1-B6), busy timeout, FK enforcement ON
 * so orphan rows are impossible rather than "unlikely".
 */
export function openDb(dbPath?: string): { client: Client; db: Db } {
  const path = resolve(dbPath ?? process.env.ARBITER_DB_PATH ?? "./data/arbiter.sqlite");
  if (!path.startsWith(":memory:") && !path.startsWith("file:")) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const url = path.startsWith("file:") || path.startsWith(":memory:")
    ? path === ":memory:"
      ? ":memory:"
      : `file:${path.replace(/^file:/, "")}`
    : `file:${path}`;

  const client = createClient({ url });
  // WAL + busy timeout: webhook writer and cron tick must not collide (P1-B6).
  client.executeMultiple("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  client.executeMultiple("PRAGMA foreign_keys=ON;");

  const db = drizzle(client, { schema });
  return { client, db };
}

export { schema };
