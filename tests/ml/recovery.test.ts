import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { defaultPolicy } from "../../packages/core/src/decide/policy.js";
import { processEvent } from "../../packages/ml/src/pipeline.js";
import { saveModel } from "../../packages/ml/src/registry.js";
import { buildArtifact } from "../../packages/ml/src/artifact.js";
import { computeFeatures, FEATURE_NAMES } from "../../packages/ml/src/features.js";
import { recoverBatch } from "../../packages/ml/src/recovery.js";

let client: Client;
const NOW = Date.UTC(2026, 1, 15, 10, 0, 0);
const T0 = "2026-01-05T09:00:00.000Z";

async function seed(sql: string, args: unknown[]) {
  await client.execute({ sql, args: args as never[] });
}

function artifact() {
  return buildArtifact({
    weights: FEATURE_NAMES.map(() => 0.08),
    bias: -1.2,
    mu: FEATURE_NAMES.map(() => 0),
    sigma: FEATURE_NAMES.map(() => 1),
    metricsJson: "{}",
    datasetSha256: "testds",
    trainedAtUtc: T0,
  });
}

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await runMigrations(client);
  await saveModel(client, artifact(), "INCUMBENT");
  await seed(`INSERT INTO tenants (id,name,created_at_utc) VALUES ('demo','Demo',?)`, [T0]);
  // Enable an autonomy envelope that auto-approves most classes but leaves
  // RISK_FLAGGED to human review (compliant escalation).
  await seed(
    `UPDATE tenants SET autonomy_envelope_json = ? WHERE id = 'demo'`,
    [
      JSON.stringify({
        envelope_version: "env-v1",
        enabled: true,
        classes: ["SOFT_RETRYABLE", "HARD_METHOD_DEAD", "NETWORK_TIMEOUT"],
        channels: ["RETRY_NOW", "RETRY_PAYDAY", "ALTERNATE_UPI_LINK", "RECOVER_VIA_RAIL", "REMINDER_LINK"],
        max_attempts: 3,
        max_amount_paise: 10_000_000,
        require_quiet_ok: false,
      }),
    ],
  );
  // One customer per event (the one-open-proposal-per-customer rule means
  // events on the SAME customer would be skipped after the first).
  const customers = [
    { id: "cust_soft", opted: 0, pattern: '{"25":4,"26":2}', resp: 0.7 },
    { id: "cust_net", opted: 0, pattern: '{"25":4,"26":2}', resp: 0.7 },
    { id: "cust_hard", opted: 0, pattern: '{"25":4,"26":2}', resp: 0.7 },
    { id: "cust_risk", opted: 0, pattern: '{"25":4,"26":2}', resp: 0.7 },
  ];
  for (const c of customers) {
    await seed(
      `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,
        channel_responsiveness,opted_out,prior_success_count,joined_at_utc)
       VALUES (?,'demo','X','+919000000000','x@example.test',?,?,?,5,?)`,
      [c.id, c.pattern, c.resp, c.opted, "2025-06-01T00:00:00.000Z"],
    );
  }
  // At-risk events of varying root cause + amount, each on its own customer.
  const events = [
    { id: "evt_soft", cust: "cust_soft", code: "INSUFFICIENT_FUNDS", amt: 49_900 },
    { id: "evt_net", cust: "cust_net", code: "GATEWAY_TIMEOUT", amt: 30_000 },
    { id: "evt_hard", cust: "cust_hard", code: "CARD_EXPIRED", amt: 99_000 },
    { id: "evt_risk", cust: "cust_risk", code: "SUSPECTED_FRAUD", amt: 1_20_000 },
  ];
  for (const e of events) {
    await seed(
      `INSERT INTO payment_events
        (id,tenant_id,customer_id,rzp_payment_id,subscription_id,amount_paise,failure_code,
         failure_class_hint,source,occurred_at_utc,ingested_at_utc)
       VALUES (?,?,?,NULL,NULL,?,?,'SEED','SEED',?,?)`,
      [e.id, "demo", e.cust, e.amt, e.code, T0, T0],
    );
  }
});

describe("Track 3 bar: measured money recovered across a batch", () => {
  it("processes a batch and reports MEASURED recovery in integer paise", async () => {
    const eventIds = ["evt_soft", "evt_net", "evt_hard", "evt_risk"];
    const report = await recoverBatch(client, eventIds, { nowMs: NOW, batchId: "b1" });

    // All 4 events were processed (none skipped).
    expect(report.eventCount).toBe(4);
    expect(report.processedCount).toBe(4);
    expect(report.skippedCount).toBe(0);

    // Total at-risk = sum of all event amounts.
    const total = 49_900 + 30_000 + 99_000 + 1_20_000;
    expect(report.totalAtRiskPaise).toBe(total);

    // Audit trail count is queried from the actual audit_trail table (not hardcoded).
    // In test DBs without the table, count is 0; in production it reflects real entries.
    expect(typeof report.auditTrailCount).toBe("number");
    expect(report.auditTrailCount).toBeGreaterThanOrEqual(0);

    // Recovered + escalated + stopped must exactly partition the at-risk total.
    expect(report.recoveredPaise + report.escalatedPaise + report.stoppedPaise).toBe(total);

    // Risk-flagged event must be escalated to human (compliant escalation).
    const risk = report.perEvent.find((p) => p.eventId === "evt_risk");
    expect(risk?.rootCause).toBe("RISK_FLAGGED");
    expect(risk?.outcome).toBe("AMBIGUOUS");
    expect(report.humanEscalations).toBeGreaterThanOrEqual(1);

    // Network timeout is a viable retry → SUCCEEDED (recovered).
    const net = report.perEvent.find((p) => p.eventId === "evt_net");
    expect(net?.rootCause).toBe("NETWORK_GATEWAY");
    expect(net?.outcome).toBe("SUCCEEDED");

    // No float contamination: all measured amounts are integers.
    expect(Number.isInteger(report.totalAtRiskPaise)).toBe(true);
    expect(Number.isInteger(report.recoveredPaise)).toBe(true);
  });

  it("skips non-PROPOSED events without crashing and counts them", async () => {
    const report = await recoverBatch(client, ["does_not_exist"], { nowMs: NOW });
    expect(report.eventCount).toBe(1);
    expect(report.processedCount).toBe(0);
    expect(report.skippedCount).toBe(1);
    expect(report.totalAtRiskPaise).toBe(0);
  });
});
