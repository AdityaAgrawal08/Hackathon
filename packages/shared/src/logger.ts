/**
 * Structured JSON logger — replaces console.log in critical paths.
 *
 * Outputs one JSON object per line (NDJSON), suitable for log aggregation.
 * Sensitive fields (phone, email, card tokens) are auto-redacted.
 *
 * Usage:
 *   import { logger } from "@arbiter/shared";
 *   logger.info({ eventId: "evt_123", msg: "proposal created" });
 *   logger.error({ err, msg: "execution failed" });
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info";

/** Redact sensitive PII fields before logging. */
function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) {
      out[k] = v;
      continue;
    }
    const key = k.toLowerCase();
    if (
      key === "phone" ||
      key === "email" ||
      key === "card" ||
      key === "card_token" ||
      key === "authorization" ||
      key === "password" ||
      key === "secret" ||
      key === "key_secret" ||
      key === "api_key" ||
      key === "authkey"
    ) {
      out[k] = "[REDACTED]";
    } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      out[k] = redact(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function write(level: LogLevel, data: Record<string, unknown>): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[MIN_LEVEL]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    ...redact(data),
  };

  const line = JSON.stringify(entry);
  if (level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const logger = {
  debug(data: Record<string, unknown>): void {
    write("debug", data);
  },
  info(data: Record<string, unknown>): void {
    write("info", data);
  },
  warn(data: Record<string, unknown>): void {
    write("warn", data);
  },
  error(data: Record<string, unknown>): void {
    write("error", data);
  },
};
