/** Default SQLite database path (used by client, migrate, and drizzle.config). */
export const DEFAULT_DB_PATH = "./data/arbiter.sqlite";

/** Default policy YAML path. */
export const DEFAULT_POLICY_PATH = "config/policy.yaml";

/** SQLite busy_timeout in milliseconds (PRAGMA busy_timeout). */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/** Default stale execution sweep threshold in minutes. */
export const STALE_EXECUTION_MINUTES = 5;

/** Maximum edit version attempts before giving up. */
export const MAX_EDIT_VERSIONS = 50;

/** Default narrative Claude API timeout in milliseconds. */
export const NARRATIVE_TIMEOUT_MS = 8000;
