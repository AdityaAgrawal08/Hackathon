import { describe, it, expect, beforeAll } from "vitest";
import { createClient } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import {
  evaluateEnvelope,
  getTenantEnvelope,
  setTenantEnvelope,
  DENY_ALL,
  writeEnvelopeAlarm,
  type AutonomyEnvelope,
} from "../../packages/core/src/approval/envelope.js";

const NOW = Date.UTC(2026, 1, 16, 10, 0, 0);

describe("P8 — Envelope hardening", () => {
  beforeAll(async () => {
    // Ensure demo tenant exists for all tests
    const c: any = createClient({ url: "file:./data/arbiter.sqlite" });
    await runMigrations(c);
    await c.execute({
      sql: `INSERT OR REPLACE INTO tenants (id, name, created_at_utc) VALUES ('demo', 'D', ?)`,
      args: ["2026-01-05T09:00:00.000Z"],
    });
  });

  it("envelope always denies HUMAN_REVIEW regardless of config", () => {
    const env: any = {
      envelope_version: "env-v1",
      enabled: true,
      classes: ["SOFT_RETRYABLE"],
      channels: ["HUMAN_REVIEW"],
      max_attempts: 5,
      max_amount_paise: 100_000,
      require_quiet_ok: true,
    };
    const result = evaluateEnvelope(env, {
      failureClass: "SOFT_RETRYABLE",
      actionId: "HUMAN_REVIEW",
      attemptsSoFar: 1,
      amountPaise: 10_000,
      quietHoursViolated: false,
    });
    // HUMAN_REVIEW must never be auto-approvable
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("HUMAN_REVIEW_NOT_AUTOAPPROVABLE");
  });

  it("envelope attempt cap equality: == cap is OVER_CAP", () => {
    const env: any = {
      envelope_version: "env-v1",
      enabled: true,
      classes: ["SOFT_RETRYABLE"],
      channels: ["REMINDER_LINK"],
      max_attempts: 2,
      max_amount_paise: 100_000,
      require_quiet_ok: true,
    };
    // attemptsSoFar == max_attempts (2 == 2) should be OVER_CAP
    const r = evaluateEnvelope(env, {
      failureClass: "SOFT_RETRYABLE",
      actionId: "REMINDER_LINK",
      attemptsSoFar: 2,
      amountPaise: 10_000,
      quietHoursViolated: false,
    });
    expect(r.reasons).toContain("ATTEMPT_OVER_CAP");
    expect(r.eligible).toBe(false);
  });

  it("envelope attempt cap under limit: < cap is eligible", () => {
    const env: any = {
      envelope_version: "env-v1",
      enabled: true,
      classes: ["SOFT_RETRYABLE"],
      channels: ["REMINDER_LINK"],
      max_attempts: 2,
      max_amount_paise: 100_000,
      require_quiet_ok: true,
    };
    // attemptsSoFar < max_attempts (1 < 2) should be eligible
    const under = evaluateEnvelope(env, {
      failureClass: "SOFT_RETRYABLE",
      actionId: "REMINDER_LINK",
      attemptsSoFar: 1,
      amountPaise: 10_000,
      quietHoursViolated: false,
    });
    expect(under.eligible).toBe(true);
    expect(under.reasons).not.toContain("ATTEMPT_OVER_CAP");
  });

  it("envelope amount cap: amount > max_amount_paise is OVER_CAP", () => {
    const env: any = {
      envelope_version: "env-v1",
      enabled: true,
      classes: ["SOFT_RETRYABLE"],
      channels: ["REMINDER_LINK"],
      max_attempts: 5,
      max_amount_paise: 50_000,
      require_quiet_ok: true,
    };
    const r = evaluateEnvelope(env, {
      failureClass: "SOFT_RETRYABLE",
      actionId: "REMINDER_LINK",
      attemptsSoFar: 1,
      amountPaise: 60_000,
      quietHoursViolated: false,
    });
    expect(r.reasons).toContain("AMOUNT_OVER_CAP");
    expect(r.eligible).toBe(false);
  });

  it("envelope amount under limit: amount <= max_amount_paise is eligible", () => {
    const env: any = {
      envelope_version: "env-v1",
      enabled: true,
      classes: ["SOFT_RETRYABLE"],
      channels: ["REMINDER_LINK"],
      max_attempts: 5,
      max_amount_paise: 50_000,
      require_quiet_ok: true,
    };
    const under = evaluateEnvelope(env, {
      failureClass: "SOFT_RETRYABLE",
      actionId: "REMINDER_LINK",
      attemptsSoFar: 1,
      amountPaise: 50_000,
      quietHoursViolated: false,
    });
    // amount == max_amount_paise should still be eligible (boundary)
    expect(under.eligible).toBe(true);
  });

  it("envelope quiet hours violated is reason when require_quiet_ok true", () => {
    const env: any = {
      envelope_version: "env-v1",
      enabled: true,
      classes: ["SOFT_RETRYABLE"],
      channels: ["REMINDER_LINK"],
      max_attempts: 5,
      max_amount_paise: 100_000,
      require_quiet_ok: true,
    };
    const r = evaluateEnvelope(env, {
      failureClass: "SOFT_RETRYABLE",
      actionId: "REMINDER_LINK",
      attemptsSoFar: 1,
      amountPaise: 10_000,
      quietHoursViolated: true,
    });
    expect(r.reasons).toContain("QUIET_HOURS");
    expect(r.eligible).toBe(false);
  });

  it("envelope quiet hours OK when require_quiet_ok false", () => {
    const env: any = {
      envelope_version: "env-v1",
      enabled: true,
      classes: ["SOFT_RETRYABLE"],
      channels: ["REMINDER_LINK"],
      max_attempts: 5,
      max_amount_paise: 100_000,
      require_quiet_ok: false,
    };
    const r = evaluateEnvelope(env, {
      failureClass: "SOFT_RETRYABLE",
      actionId: "REMINDER_LINK",
      attemptsSoFar: 1,
      amountPaise: 10_000,
      quietHoursViolated: true,
    });
    // quiet hours should not be a reason when not required
    expect(r.eligible).toBe(true);
    expect(r.reasons).not.toContain("QUIET_HOURS");
  });

  it("getTenantEnvelope throws for unknown tenant", async () => {
    const c: any = createClient({ url: ":memory:" });
    await runMigrations(c);
    await c.execute({ sql: `INSERT INTO tenants (id, name, created_at_utc) VALUES ('demo', 'D', ?)`, args: ["2026-01-05T09:00:00.000Z"] });
    await expect(getTenantEnvelope(c, "ghost")).rejects.toThrow(/unknown tenant/);
  });

  it("setTenantEnvelope re-validates strictly on write (Zod strict)", async () => {
    const c: any = createClient({ url: ":memory:" });
    await runMigrations(c);
    await c.execute({ sql: `INSERT INTO tenants (id, name, created_at_utc) VALUES ('demo', 'D', ?)`, args: ["2026-01-05T09:00:00.000Z"] });
    await setTenantEnvelope(c, "demo", DENY_ALL);
    // Pass an object with extra field - Zod strict should reject
    const bad = { ...DENY_ALL, super_secret: true } as unknown;
    await expect(setTenantEnvelope(c, "demo", bad)).rejects.toThrow();
  });

  it("writeEnvelopeAlarm only writes once per tenant (idempotent)", async () => {
    const c: any = createClient({ url: "file:./data/arbiter.sqlite" });
    await runMigrations(c);
    await c.execute({ sql: `INSERT OR REPLACE INTO tenants (id, name, created_at_utc) VALUES ('demo', 'D', ?)`, args: ["2026-01-05T09:00:00.000Z"] });
    // First call should write
    await writeEnvelopeAlarm(c, "demo");
    // Second call should be no-op (already exists)
    const r1 = await c.execute({ sql: `SELECT 1 FROM audit_log WHERE tenant_id = ? AND actor = 'SYSTEM' AND entry_type = 'TRIGGER' AND payload_json LIKE '%ENVELOPE_CORRUPT%' LIMIT 1`, args: ["demo"] });
    expect(r1.rows.length).toBe(1);
    await writeEnvelopeAlarm(c, "demo");
    const r2 = await c.execute({ sql: `SELECT count(*) as n FROM audit_log WHERE tenant_id = ? AND actor = 'SYSTEM' AND entry_type = 'TRIGGER' AND payload_json LIKE '%ENVELOPE_CORRUPT%'`, args: ["demo"] });
    expect(r2.rows[0].n).toBe(1); // Still just 1
  });
});