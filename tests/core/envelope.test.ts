import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import {
  parseEnvelope,
  evaluateEnvelope,
  getTenantEnvelope,
  setTenantEnvelope,
  writeEnvelopeAlarm,
  DENY_ALL,
  type AutonomyEnvelope,
} from "../../packages/core/src/approval/envelope.js";
import {
  listApprovalQueue,
  groupQueue,
} from "../../packages/core/src/approval/queue.js";

let client: Client;
const T0 = "2026-02-01T00:00:00.000Z";

const PERMISSIVE: AutonomyEnvelope = {
  envelope_version: "env-v1",
  enabled: true,
  classes: ["SOFT_RETRYABLE"],
  channels: ["ALTERNATE_UPI_LINK", "REMINDER_LINK"],
  max_attempts: 2,
  max_amount_paise: 50_000,
  require_quiet_ok: true,
};

async function mkQueueProposal(client: Client, id: string, code: string, action: string, ev: number) {
  const custId = `q_cust_${id}`;
  await client.execute({
    sql: `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,joined_at_utc)
          VALUES (?,'demo','Q','+919000000000','q@example.test',?)`,
    args: [custId, T0],
  });
  await client.execute({
    sql: `INSERT INTO payment_events (id,tenant_id,customer_id,amount_paise,failure_code,
            source,occurred_at_utc,ingested_at_utc)
          VALUES (?, 'demo',?,49900,?,'SEED',?,?)`,
    args: [`q_evt_${id}`, custId, code, T0, T0],
  });
  await client.execute({
    sql: `INSERT INTO proposals (id,event_id,customer_id,model_version_id,policy_version,
            action_json,ev_paise,confidence,state,state_version,dedupe_key,created_at_utc,updated_at_utc)
          VALUES (?,?,?,?,?,'{"action":"NO_ACTION"}',?,0.5,'AWAITING_APPROVAL',0,?,?,?)`,
    args: [
      `q_prop_${id}`,
      `q_evt_${id}`,
      custId,
      "mv_test",
      "policy-v1",
      ev,
      `dk_q_${id}`,
      T0,
      T0,
    ],
  });
}

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
});

describe("envelope parsing (deny-by-default)", () => {
  it("empty or {} tenant column ⇒ deny-all (P4-B3)", () => {
    expect(parseEnvelope("")).toEqual(DENY_ALL);
    expect(parseEnvelope("{}")).toEqual(DENY_ALL);
    expect(parseEnvelope("{}").enabled).toBe(false);
  });

  it("valid json parses; unknown keys and bad values are boot errors", () => {
    expect(parseEnvelope(JSON.stringify(PERMISSIVE))).toEqual(PERMISSIVE);
    expect(() => parseEnvelope(JSON.stringify({ ...PERMISSIVE, extra_key: 1 }))).toThrow();
    expect(() => parseEnvelope(JSON.stringify({ ...PERMISSIVE, max_attempts: -1 }))).toThrow();
    expect(() => parseEnvelope("not json")).toThrow();
    expect(() => parseEnvelope("[]")).toThrow();
  });

  it("corrupt stored envelope ⇒ deny-all + corruption flag (alarm material)", async () => {
    client = createClient({ url: ":memory:" });
    await runMigrations(client);
    await client.execute({
      sql: `INSERT INTO tenants (id,name,autonomy_envelope_json,created_at_utc)
            VALUES ('demo','D','{ broken', ?)`,
      args: [T0],
    });
    const r = await getTenantEnvelope(client, "demo");
    expect(r.corrupted).toBe(true);
    expect(r.envelope.enabled).toBe(false);
    await writeEnvelopeAlarm(client, "demo");
    const alarm = await client.execute({
      sql: `SELECT payload_json FROM audit_log WHERE actor='SYSTEM' AND entry_type='TRIGGER'`,
    });
    expect(JSON.parse(String(alarm.rows[0]!.payload_json)).alarm).toBe("ENVELOPE_CORRUPT");
  });

  it("set/get round-trips a strict envelope", async () => {
    client = createClient({ url: ":memory:" });
    await runMigrations(client);
    await client.execute({
      sql: `INSERT INTO tenants (id,name,created_at_utc) VALUES ('demo','D',?)`,
      args: [T0],
    });
    await setTenantEnvelope(client, "demo", PERMISSIVE);
    const r = await getTenantEnvelope(client, "demo");
    expect(r.corrupted).toBe(false);
    expect(r.envelope).toEqual(PERMISSIVE);
  });
});

describe("evaluateEnvelope collects ALL failing conditions", () => {
  it("eligible when every condition holds", () => {
    const r = evaluateEnvelope(PERMISSIVE, {
      failureClass: "SOFT_RETRYABLE",
      actionId: "REMINDER_LINK",
      attemptsSoFar: 1,
      amountPaise: 49_900,
      quietHoursViolated: false,
    });
    expect(r).toEqual({ eligible: true, reasons: [] });
  });

  it("reports every violated condition at once (P4-B3 spirit)", () => {
    const r = evaluateEnvelope(PERMISSIVE, {
      failureClass: "RISK_FLAGGED",
      actionId: "RETRY_NOW",
      attemptsSoFar: 5,
      amountPaise: 99_000,
      quietHoursViolated: true,
    });
    expect(r.eligible).toBe(false);
    expect(r.reasons).toEqual([
      "CLASS_NOT_ALLOWED",
      "CHANNEL_NOT_ALLOWED",
      "ATTEMPT_OVER_CAP",
      "AMOUNT_OVER_CAP",
      "QUIET_HOURS",
    ]);
  });

  it("disabled envelope refuses everything even for perfect matches", () => {
    const r = evaluateEnvelope(
      { ...PERMISSIVE, enabled: false },
      {
        failureClass: "SOFT_RETRYABLE",
        actionId: "REMINDER_LINK",
        attemptsSoFar: 0,
        amountPaise: 100,
        quietHoursViolated: false,
      },
    );
    expect(r).toEqual({ eligible: false, reasons: ["ENVELOPE_DISABLED"] });
  });
});

describe("approval queue ordering + grouping (P4-B8)", () => {
  it("orders by EV desc within groups; groups sorted by total EV", async () => {
    client = createClient({ url: ":memory:" });
    await runMigrations(client);
    await client.execute({
      sql: `INSERT INTO tenants (id,name,created_at_utc) VALUES ('demo','D',?)`,
      args: [T0],
    });
    await client.execute({
      sql: `INSERT INTO model_versions (id,kind,weights_json,weights_sha256,dataset_sha256,
              feature_names_json,metrics_json,trained_at_utc,status)
            VALUES ('mv_test','logreg','{}','sha_test','ds_test','[]','{}',?,'CANDIDATE')`,
      args: [T0],
    });
    await mkQueueProposal(client, "a", "INSUFFICIENT_FUNDS", "RETRY_PAYDAY", 100);
    await mkQueueProposal(client, "b", "INSUFFICIENT_FUNDS", "RETRY_PAYDAY", 900);
    await mkQueueProposal(client, "c", "GATEWAY_TIMEOUT", "RETRY_NOW", 500);

    const rows = await listApprovalQueue(client);
    expect(rows.map((r) => r.evPaise)).toEqual([900, 500, 100]);

    const groups = groupQueue(rows);
    expect(groups[0]!.count).toBe(2);
    expect(groups[0]!.totalEvPaise).toBe(1000);
    expect(groups.map((g) => g.key)).toContain("GATEWAY_TIMEOUT×RETRY_NOW");
  });
});
