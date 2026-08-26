import { describe, it, expect } from "vitest";
import { decide, type DecideInput } from "../../packages/core/src/decide/engine.js";
import { defaultPolicy } from "../../packages/core/src/decide/policy.js";
import {
  evaluateEnvelope,
  getTenantEnvelope,
  setTenantEnvelope,
  DENY_ALL,
  type AutonomyEnvelope,
} from "../../packages/core/src/approval/envelope.js";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";

const NOW = Date.UTC(2026, 1, 16, 10, 0, 0);

function input(overrides: Partial<DecideInput> = {}): DecideInput {
  return {
    probability: 0.4,
    failureClass: "SOFT_RETRYABLE",
    amountPaise: 49_900,
    nowMs: NOW,
    policy: defaultPolicy(),
    inferredPaydayDay: 25,
    ...overrides,
  };
}

describe("decide() — numeric and policy boundaries", () => {
  it("probability exactly 1 never lets EV exceed amount (worst-case sweep)", () => {
    const out = decide(input({ probability: 1, failureClass: "NETWORK_TIMEOUT" }));
    for (const r of out.ranked) expect(r.evPaise).toBeLessThanOrEqual(49_900);
    const retry = out.ranked.find((r) => r.action === "RETRY_NOW")!;
    expect(retry.multiplierUsed).toBe(1.5);
    expect(retry.adjustedProbabilityBp).toBe(10_000); // clamped, not 15000
    expect(retry.evPaise).toBe(49_900 - 300);
  });

  it("probability exactly 0 makes NO_ACTION the only non-loss option", () => {
    const out = decide(input({ probability: 0 }));
    expect(out.chosen.action).toBe("NO_ACTION");
    expect(out.chosen.evPaise).toBe(0);
  });

  it("attempts == cap refuses (equality boundary, not off-by-one)", () => {
    const out = decide(input({ attemptsSoFar: 2 }));
    expect(out.refusals.find((r) => r.action === "RETRY_PAYDAY")!.violatedRules)
      .toContain("ATTEMPT_CAP");
    const ok = decide(input({ attemptsSoFar: 1 }));
    expect(ok.ranked.some((r) => r.action === "RETRY_PAYDAY")).toBe(true);
  });

  it("amount == exposure cap passes; one paise over refuses", () => {
    const at = decide(input({ amountPaise: 100_000_00 }));
    expect(at.refusals.find((r) => r.action === "RETRY_NOW")?.violatedRules ?? [])
      .not.toContain("EXPOSURE_CAP");
    const over = decide(input({ amountPaise: 100_000_01 }));
    expect(over.refusals.find((r) => r.action === "RETRY_NOW")!.violatedRules)
      .toContain("EXPOSURE_CAP");
  });

  it("adjusted probability == floor passes the gate exactly", () => {
    const atFloor = { ...defaultPolicy(), confidence_floor_bp: 2_400 };
    const pass = decide(input({ probability: 0.4, policy: atFloor }));
    const retryNow = pass.ranked.find((r) => r.action === "RETRY_NOW")!;
    expect(retryNow.adjustedProbabilityBp).toBe(2_400);

    const justOver = { ...defaultPolicy(), confidence_floor_bp: 2_401 };
    const fail = decide(input({ probability: 0.4, policy: justOver }));
    expect(fail.refusals.find((r) => r.action === "RETRY_NOW")!.violatedRules)
      .toContain("CONFIDENCE_FLOOR");
  });

  it("min-interval equality (elapsed == window) is allowed; a second less is not", () => {
    const interval = 24 * 3_600_000;
    const last = NOW - interval;
    const exact = decide(input({ lastContactAtMs: last }));
    expect(exact.refusals.find((r) => r.action === "RETRY_NOW")?.violatedRules ?? [])
      .not.toContain("MIN_INTERVAL");
    const fresh = decide(input({ lastContactAtMs: last + 999 }));
    expect(fresh.refusals.find((r) => r.action === "RETRY_NOW")!.violatedRules)
      .toContain("MIN_INTERVAL");
  });

  it("one-paise payments decide without crashing", () => {
    const out = decide(input({ amountPaise: 1, probability: 0.9 }));
    expect(out.chosen.action).toBeDefined();
    for (const r of out.ranked) expect(Number.isInteger(r.evPaise)).toBe(true);
  });

  it("custom multiplier tables are clamped to [0,10] per cell", () => {
    const wild = input({
      multipliers: {
        SOFT_RETRYABLE: { RETRY_NOW: 99 },
        HARD_METHOD_DEAD: {},
        NETWORK_TIMEOUT: {},
        RISK_FLAGGED: {},
        UNKNOWN: {},
      },
      probability: 0.5,
    });
    const r = decide(wild).ranked.find((x) => x.action === "RETRY_NOW")!;
    expect(r.multiplierUsed).toBe(10);
    expect(r.adjustedProbabilityBp).toBe(10_000);
  });
});

const ENVELOPE: AutonomyEnvelope = {
  envelope_version: "env-v1",
  enabled: true,
  classes: ["SOFT_RETRYABLE"],
  channels: ["REMINDER_LINK"],
  max_attempts: 2,
  max_amount_paise: 50_000,
  require_quiet_ok: true,
};

describe("envelope — attempt-cap parity with policy (audit fix)", () => {
  it("attempts == envelope cap is now OVER_CAP (was silently eligible)", () => {
    const r = evaluateEnvelope(ENVELOPE, {
      failureClass: "SOFT_RETRYABLE",
      actionId: "REMINDER_LINK",
      attemptsSoFar: 2,
      amountPaise: 10_000,
      quietHoursViolated: false,
    });
    expect(r.reasons).toContain("ATTEMPT_OVER_CAP");
    const under = evaluateEnvelope(ENVELOPE, {
      failureClass: "SOFT_RETRYABLE",
      actionId: "REMINDER_LINK",
      attemptsSoFar: 1,
      amountPaise: 10_000,
      quietHoursViolated: false,
    });
    expect(under.eligible).toBe(true);
  });

  it("unknown tenant fails loudly instead of inventing an envelope", async () => {
    const c: Client = createClient({ url: ":memory:" });
    await runMigrations(c);
    await expect(getTenantEnvelope(c, "ghost")).rejects.toThrow(/unknown tenant/);
  });

  it("setTenantEnvelope re-validates strictly on write", async () => {
    const c: Client = createClient({ url: ":memory:" });
    await runMigrations(c);
    await c.execute({
      sql: `INSERT INTO tenants (id,name,created_at_utc) VALUES ('demo','D','2026-01-01')`,
    });
    await setTenantEnvelope(c, "demo", DENY_ALL);
    const bad = { ...DENY_ALL, extra: true } as unknown as AutonomyEnvelope;
    await expect(setTenantEnvelope(c, "demo", bad)).rejects.toThrow();
  });
});
