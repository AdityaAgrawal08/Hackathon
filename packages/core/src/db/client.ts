import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema.js";
import { DEFAULT_DB_PATH, SQLITE_BUSY_TIMEOUT_MS } from "../constants.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export async function openDb(dbPath?: string): Promise<{ client: Client; db: Db }> {
  const raw = dbPath ?? process.env.ARBITER_DB_PATH ?? DEFAULT_DB_PATH;

  if (raw.startsWith("libsql:") || raw.startsWith("http:") || raw.startsWith("https:")) {
    const client = createClient({
      url: raw,
      authToken: process.env.ARBITER_DB_TOKEN,
    });
    const db = drizzle(client, { schema });
    return { client, db };
  }

  if (raw === ":memory:" || raw === "file::memory:?cache=shared") {
    const client = createClient({ url: ":memory:" });
    await client.executeMultiple(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS};`);
    await client.executeMultiple("PRAGMA foreign_keys=ON;");
    const db = drizzle(client, { schema });
    return { client, db };
  }

  const path = resolve(raw);
  if (!path.startsWith("file:") && !path.startsWith("libsql:") && !path.startsWith("http:") && !path.startsWith("https:")) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const url = path.startsWith("file:") ? path : `file:${path}`;
  const client = createClient({ url });
  await client.executeMultiple(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS};`);
  await client.executeMultiple("PRAGMA foreign_keys=ON;");

  const db = drizzle(client, { schema });
  return { client, db };
}

export { schema };
