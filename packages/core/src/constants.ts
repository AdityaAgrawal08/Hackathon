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

/** Checkout session time-to-live in milliseconds (15 minutes). */
export const CHECKOUT_SESSION_TTL_MS = 15 * 60 * 1000;

/** Maximum duration for automated two-way reconciliation before manual review (5 minutes). */
export const MAX_RECONCILIATION_TTL_MS = 5 * 60 * 1000;

/** Default fallback test secrets (strictly for LOCAL_SANDBOX/dev mode). */
export const DEFAULT_LOCAL_WEBHOOK_SECRET = "whsec_local_test_secret_12345";
export const DEFAULT_LOCAL_ADMIN_SECRET = "arbiter_admin_secret_key_2026";

/** Per-endpoint rate limit configurations. */
export const RATE_LIMIT_CHECKOUT_ORDERS_PER_MIN = 20;
export const RATE_LIMIT_CHARGES_PER_MIN = 30;
export const RATE_LIMIT_WEBHOOKS_PER_MIN = 200;
export const RATE_LIMIT_ADMIN_PER_MIN = 30;

/** Resource limit for concurrent SSE status connections per token. */
export const MAX_SSE_CONNECTIONS_PER_TOKEN = 5;
