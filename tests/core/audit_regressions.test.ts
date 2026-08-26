import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { recordFailureEvent } from "../../packages/core/src/ingest/replay.js";
import { canonicalJson } from "../../packages/ml/src/artifact.js";
import { decide } from "../../packages/core/src/decide/engine.js";
import { defaultPolicy } from "../../packages/core/src/decide/policy.js";
import {
  evaluateEnvelope,
  writeEnvelopeAlarm,
  getTenantEnvelope,
} from "../../packages/core/src/approval/envelope.js";
import type { AutonomyEnvelope } from "../../packages/core/src/approval/envelope.js";

const T0 = "2026-02-01T00:00:00.000Z";
const NOW = Date.UTC(2026, 1, 16, 10, 0, 0);

describe("audit-fix regressions", () => {
  it("replay no longer swallows non-duplicate DB errors as DUPLICATE", async () => {
    const c = createClient({ url: ":memory:" });
    await runMigrations(c);
    await c.execute({
      sql: `INSERT INTO tenants (id,name,created_at_utc) VALUES ('demo','D',?)`,
      args: [T0],
    });

    const base = {
      tenantId: "demo",
      customerId: null,
      rzpPaymentId: null,
      subscriptionId: null,
      amountPaise: 100,
      failureCode: "X",
      failureClassHint: null,
      source: "SEED" as const,
      occurredAtUtc: T0,
    };

    expect(await recordFailureEvent(c, { ...base, id: "e1" }, T0)).toBe("INSERTED");
    expect(await recordFailureEvent(c, { ...base, id: "e1" }, T0)).toBe("DUPLICATE");

    await expect(
      recordFailureEvent(
        c,
        { ...base, id: "e_orphan", customerId: "no_such_customer" },
        T0,
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
    void createClient;
  });

  it("canonicalJson sorts nested keys and keeps flat output byte-identical", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: { y: 2, x: 1 }, a: [3, { c: 1, b: 2 }] })).toBe(
      '{"a":[3,{"b":2,"c":1}],"z":{"x":1,"y":2}}',
    );
  });

  it("decide() stays total even with a corrupt payday day (no throw)", () => {
    for (const bad of [32, 0, -5, Number.NaN]) {
      const out = decide({
        probability: 0.4,
        failureClass: "SOFT_RETRYABLE",
        amountPaise: 49_900,
        nowMs: NOW,
        policy: defaultPolicy(),
        inferredPaydayDay: bad,
      });
      expect(out.chosen.action).toBeDefined();
      const paydayRow =
        out.ranked.find((r) => r.action === "RETRY_PAYDAY") ??
        out.refusals.find((r) => r.action === "RETRY_PAYDAY");
      expect(paydayRow).toBeDefined();
    }
  });

  it("HUMAN_REVIEW can never be auto-approved — the gate stays human", () => {
    const permissive: AutonomyEnvelope = {
      envelope_version: "env-v1",
      enabled: true,
      classes: ["SOFT_RETRYABLE", "HARD_METHOD_DEAD", "NETWORK_TIMEOUT", "RISK_FLAGGED", "UNKNOWN"],
      channels: ["HUMAN_REVIEW", "RETRY_NOW", "NO_ACTION"],
      max_attempts: 10,
      max_amount_paise: 10_000_000,
      require_quiet_ok: false,
    };
    const r = evaluateEnvelope(permissive, {
      failureClass: "RISK_FLAGGED",
      actionId: "HUMAN_REVIEW",
      attemptsSoFar: 0,
      amountPaise: 100,
      quietHoursViolated: false,
    });
    expect(r.eligible).toBe(false);
    expect(r.reasons).toEqual(["HUMAN_REVIEW_NOT_AUTOAPPROVABLE"]);
  });

  it("corrupt-envelope alarm is written once per tenant, not once per event", async () => {
    const c = createClient({ url: ":memory:" });
    await runMigrations(c);
    await c.execute({
      sql: `INSERT INTO tenants (id,name,autonomy_envelope_json,created_at_utc)
            VALUES ('demo','D','{broken',?)`,
      args: [T0],
    });
    for (let i = 0; i < 5; i++) {
      const { corrupted } = await getTenantEnvelope(c, "demo");
      if (corrupted) await writeEnvelopeAlarm(c, "demo");
    }
    const alarms = await c.execute({
      sql: `SELECT count(*) n FROM audit_log WHERE payload_json LIKE '%ENVELOPE_CORRUPT%'`,
    });
    expect(Number(alarms.rows[0]!.n)).toBe(1);
  });

  it("incumbent promotion leaves exactly one incumbent even under repeated saves", async () => {
    const c = createClient({ url: ":memory:" });
    await runMigrations(c);
    const { saveModel } = await import("../../packages/ml/src/registry.js");
    const { buildArtifact } = await import("../../packages/ml/src/artifact.js");
    const mk = (w: number, at: string) =>
      buildArtifact({
        weights: [w],
        bias: 0,
        mu: [0],
        sigma: [1],
        metricsJson: "{}",
        datasetSha256: "ds",
        trainedAtUtc: at,
      });
    for (const [w, at] of [
      [0.1, "2026-01-01T00:00:00.000Z"],
      [0.2, "2026-01-02T00:00:00.000Z"],
      [0.3, "2026-01-03T00:00:00.000Z"],
      [0.2, "2026-01-02T00:00:00.000Z"],
    ] as const) {
      await saveModel(c, mk(w, at), "INCUMBENT");
    }
    const rows = await c.execute(`SELECT id,status FROM model_versions`);
    const byId = new Map(rows.rows.map((r) => [String(r.id), String(r.status)]));
    const incumbents = [...byId.values()].filter((s) => s === "INCUMBENT");
    expect(incumbents).toHaveLength(1);
    expect(byId.get(mk(0.2, "x").id)).toBe("INCUMBENT");
  });
});
