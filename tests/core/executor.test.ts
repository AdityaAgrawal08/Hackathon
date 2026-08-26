import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { isoUtc } from "../../packages/shared/src/time.js";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { approveProposal } from "../../packages/core/src/approval/actions.js";
import {
  executeProposal,
  reconcileProposal,
  sweepStuckExecutions,
  executeAll,
  idempotencyKey,
  rzpRequestRef,
  type ExecutionOutcome,
} from "../../packages/core/src/executor/index.js";
import { saveModel } from "../../packages/ml/src/registry.js";
import { buildArtifact } from "../../packages/ml/src/artifact.js";
import { FEATURE_NAMES } from "../../packages/ml/src/features.js";

const T0 = "2026-01-05T09:00:00.000Z";
const NOW = Date.UTC(2026, 1, 16, 10, 0, 0);

function artifact() {
  return buildArtifact({
    weights: FEATURE_NAMES.map(() => 0.08),
    bias: -1.2,
    mu: FEATURE_NAMES.map(() => 0),
    sigma: FEATURE_NAMES.map(() => 1),
    metricsJson: "{}",
    datasetSha256: "ds",
    trainedAtUtc: T0,
  });
}

let client: Client;
let seq = 0;
let MODEL_ID = "";

/** Seed a customer + event + proposal in APPROVED state */
async function seedProposal(
  code: string,
  amountPaise: number,
  opts: { failureClass?: string; action?: string } = {},
): Promise<string> {
  const n = ++seq;
  const custId = `c_exec_${n}`;
  const evtId = `e_exec_${n}`;
  const propId = `p_exec_${n}`;
  const failureClass = opts.failureClass ?? "SOFT_RETRYABLE";
  const actionId = opts.action ?? "RETRY_PAYDAY";

  await client.execute({
    sql: `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,
            channel_responsiveness,opted_out,prior_success_count,joined_at_utc)
          VALUES (?, 'demo','C','+919000000000','c@example.test','{"25":5}',0.7,0,6,'2025-06-01')`,
    args: [custId],
  });
  await client.execute({
    sql: `INSERT INTO payment_events (id,tenant_id,customer_id,rzp_payment_id,subscription_id,
            amount_paise,failure_code,failure_class_hint,source,true_outcome_seed,occurred_at_utc,ingested_at_utc)
          VALUES (?, 'demo',?,NULL,NULL,?,?,?,'SEED',NULL,'2026-02-14T09:00:00.000Z','2026-02-14T09:01:00.000Z')`,
    args: [evtId, custId, amountPaise, code, failureClass],
  });

  await client.execute({
    sql: `INSERT INTO proposals (id,event_id,customer_id,model_version_id,policy_version,
            action_json,ev_paise,confidence,attributions_json,narrative,state,state_version,
            dedupe_key,created_at_utc,updated_at_utc)
          VALUES (?,?,?,?,?,?,?,?,?,NULL,'APPROVED',0,?,?,?)`,
    args: [
      propId,
      evtId,
      custId,
      MODEL_ID,
      "policy-v1",
      JSON.stringify({ action: actionId, evPaise: amountPaise }),
      amountPaise,
      0.5,
      "[]",
      `${evtId}|logreg@0.1.0+test|policy-v1`,
      T0,
      T0,
    ],
  });

  return propId;
}

/** Seed proposal directly in AUTO_APPROVED state */
async function seedAutoApproved(
  code: string,
  amountPaise: number,
  actionId = "RETRY_PAYDAY",
): Promise<string> {
  const n = ++seq;
  const custId = `c_auto_${n}`;
  const evtId = `e_auto_${n}`;
  const propId = `p_auto_${n}`;

  await client.execute({
    sql: `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,
            channel_responsiveness,opted_out,prior_success_count,joined_at_utc)
          VALUES (?, 'demo','C','+919000000000','c@example.test','{"25":5}',0.7,0,6,'2025-06-01')`,
    args: [custId],
  });
  await client.execute({
    sql: `INSERT INTO payment_events (id,tenant_id,customer_id,rzp_payment_id,subscription_id,
            amount_paise,failure_code,failure_class_hint,source,true_outcome_seed,occurred_at_utc,ingested_at_utc)
          VALUES (?, 'demo',?,NULL,NULL,?,?,'SOFT_RETRYABLE','SEED',NULL,'2026-02-14T09:00:00.000Z','2026-02-14T09:01:00.000Z')`,
    args: [evtId, custId, amountPaise, code],
  });

  await client.execute({
    sql: `INSERT INTO proposals (id,event_id,customer_id,model_version_id,policy_version,
            action_json,ev_paise,confidence,attributions_json,narrative,state,state_version,
            dedupe_key,created_at_utc,updated_at_utc)
          VALUES (?,?,?,?,?,?,?,?,?,NULL,'AUTO_APPROVED',0,?,?,?)`,
    args: [
      propId,
      evtId,
      custId,
      MODEL_ID,
      "policy-v1",
      JSON.stringify({ action: actionId, evPaise: amountPaise }),
      amountPaise,
      0.5,
      "[]",
      `${evtId}|logreg@0.1.0+test|policy-v1`,
      T0,
      T0,
    ],
  });

  return propId;
}

async function stateOf(id: string): Promise<string> {
  const r = await client.execute({ sql: `SELECT state FROM proposals WHERE id=?`, args: [id] });
  return String(r.rows[0]!.state);
}

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await runMigrations(client);
  await saveModel(client, artifact(), "INCUMBENT");
  await client.execute({
    sql: `INSERT INTO tenants (id,name,created_at_utc) VALUES ('demo','D',?)`,
    args: [T0],
  });
  const m = await client.execute(`SELECT id FROM model_versions WHERE status='INCUMBENT'`);
  MODEL_ID = String(m.rows[0]!.id);
});

/* ── idempotency key determinism ───────────────────────────────── */

describe("idempotency key", () => {
  it("same inputs → same key (P5-B2)", () => {
    const k1 = idempotencyKey("p1", "m1", "policy-v1", '{"action":"RETRY_PAYDAY"}');
    const k2 = idempotencyKey("p1", "m1", "policy-v1", '{"action":"RETRY_PAYDAY"}');
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[a-f0-9]{16}$/);
  });

  it("different inputs → different key", () => {
    const k1 = idempotencyKey("p1", "m1", "policy-v1", '{"action":"RETRY_PAYDAY"}');
    const k2 = idempotencyKey("p2", "m1", "policy-v1", '{"action":"RETRY_PAYDAY"}');
    expect(k1).not.toBe(k2);
  });

  it("rzpRequestRef is deterministic", () => {
    const r1 = rzpRequestRef("p1", "RETRY_PAYDAY");
    const r2 = rzpRequestRef("p1", "RETRY_PAYDAY");
    expect(r1).toBe(r2);
    expect(r1).toMatch(/^[a-f0-9]{12}$/);
  });
});

/* ── execution lifecycle ───────────────────────────────────────── */

describe("executeProposal", () => {
  it("APPROVED → EXECUTED with SUCCEEDED (RETRY_PAYDAY, high EV)", async () => {
    const id = await seedProposal("INSUFFICIENT_FUNDS", 600_000);
    expect(await stateOf(id)).toBe("APPROVED");

    const r = await executeProposal(client, { proposalId: id, nowMs: NOW });
    expect(r.outcome).toBe("SUCCEEDED");
    expect(r.actionId).toBe("RETRY_PAYDAY");
    expect(r.idempotencyKey).toMatch(/^[a-f0-9]{16}$/);
    expect(r.rzpRequestRef).toMatch(/^[a-f0-9]{12}$/);
    expect(await stateOf(id)).toBe("EXECUTED");

    // actions row recorded
    const a = await client.execute({ sql: `SELECT outcome FROM actions WHERE proposal_id=?`, args: [id] });
    expect(a.rows[0]!.outcome).toBe("SUCCEEDED");

    // audit trail written
    const log = await client.execute({
      sql: `SELECT payload_json FROM audit_log WHERE entry_type='ACTION' AND event_id IN
            (SELECT event_id FROM proposals WHERE id=?)`,
      args: [id],
    });
    expect(log.rows.length).toBe(1);
    const payload = JSON.parse(String(log.rows[0]!.payload_json));
    expect(payload.outcome).toBe("SUCCEEDED");
    expect(payload.action).toBe("RETRY_PAYDAY");
  });

  it("APPROVED → FAILED with DEAD action (RETRY_NOW × HARD_METHOD_DEAD, mult=0)", async () => {
    const id = await seedProposal("EXPIRED_CARD", 50_000, {
      failureClass: "HARD_METHOD_DEAD",
      action: "RETRY_NOW",
    });
    const r = await executeProposal(client, { proposalId: id, nowMs: NOW });
    expect(r.outcome).toBe("FAILED");
    expect(await stateOf(id)).toBe("FAILED");
  });

  it("AUTO_APPROVED → EXECUTED (auto-path works too)", async () => {
    const id = await seedAutoApproved("TEMPORARY_DECLINE", 40_000);
    expect(await stateOf(id)).toBe("AUTO_APPROVED");

    const r = await executeProposal(client, { proposalId: id, nowMs: NOW });
    expect(r.outcome).toBe("SUCCEEDED");
    expect(await stateOf(id)).toBe("EXECUTED");
  });

  it("HUMAN_REVIEW → AMBIGUOUS (needs a human)", async () => {
    const id = await seedProposal("SUSPECTED_FRAUD", 100_000, {
      failureClass: "RISK_FLAGGED",
      action: "HUMAN_REVIEW",
    });
    const r = await executeProposal(client, { proposalId: id, nowMs: NOW });
    expect(r.outcome).toBe("AMBIGUOUS");
    expect(await stateOf(id)).toBe("FAILED");
  });

  it("throws on unknown proposal", async () => {
    await expect(
      executeProposal(client, { proposalId: "no_such_proposal", nowMs: NOW }),
    ).rejects.toThrow("UNKNOWN_PROPOSAL");
  });

  it("throws on non-runnable state (REJECTED proposal)", async () => {
    const id = await seedProposal("NETWORK_ERROR", 30_000);
    await client.execute({
      sql: `UPDATE proposals SET state='REJECTED' WHERE id=?`,
      args: [id],
    });
    await expect(
      executeProposal(client, { proposalId: id, nowMs: NOW }),
    ).rejects.toThrow("not APPROVED/AUTO_APPROVED");
  });
});

/* ── determinism barrier ───────────────────────────────────────── */

describe("determinism barrier", () => {
  it("idempotency key is stable across 100 derivations (P5-B1)", () => {
    const id = "prop_test";
    const mv = "logreg@0.1.0+test";
    const pv = "policy-v1";
    const aj = JSON.stringify({ action: "RETRY_PAYDAY", evPaise: 600_000 });
    const keys = Array.from({ length: 100 }, () => idempotencyKey(id, mv, pv, aj));
    expect(new Set(keys).size).toBe(1);
  });

  it("same action × same class → same outcome across failure codes", async () => {
    for (const code of ["INSUFFICIENT_FUNDS", "TEMPORARY_DECLINE", "NETWORK_ERROR"]) {
      const id = await seedProposal(code, 100_000, { action: "RETRY_NOW" });
      const r = await executeProposal(client, { proposalId: id, nowMs: NOW });
      expect(r.outcome).toBe("SUCCEEDED");
    }

    for (const code of ["EXPIRED_CARD", "CARD_DECLINED"]) {
      const id = await seedProposal(code, 100_000, {
        failureClass: "HARD_METHOD_DEAD",
        action: "RETRY_NOW",
      });
      const r = await executeProposal(client, { proposalId: id, nowMs: NOW });
      expect(r.outcome).toBe("FAILED");
    }
  });
});

/* ── idempotency on re-execute ─────────────────────────────────── */

describe("idempotency", () => {
  it("second executeProposal on same proposal throws (wrong state)", async () => {
    const id = await seedProposal("TEMPORARY_DECLINE", 200_000);
    const r1 = await executeProposal(client, { proposalId: id, nowMs: NOW });
    expect(r1.outcome).toBe("SUCCEEDED");

    await expect(
      executeProposal(client, { proposalId: id, nowMs: NOW }),
    ).rejects.toThrow("not APPROVED/AUTO_APPROVED");
  });
});

/* ── reconciliation ────────────────────────────────────────────── */

describe("reconcileProposal", () => {
  it("reconciles a stuck EXECUTING proposal to EXECUTED", async () => {
    const id = await seedProposal("NETWORK_TIMEOUT", 80_000, {
      failureClass: "NETWORK_TIMEOUT",
      action: "RETRY_NOW",
    });
    await client.execute({
      sql: `UPDATE proposals SET state='EXECUTING' WHERE id=?`,
      args: [id],
    });
    await client.execute({
      sql: `INSERT INTO actions (id,proposal_id,idempotency_key,executor,payload_json,rzp_request_ref,outcome,executed_at_utc)
            VALUES (?,?,?,?,?,?,?,?)`,
      args: [`act-${id}`, id, "fake-key", "RETRY_NOW", "{}", "fake-ref", "PENDING", T0],
    });

    const r = await reconcileProposal(client, {
      proposalId: id,
      nowMs: NOW,
      outcome: "SUCCEEDED",
    });
    expect(r).not.toBeNull();
    expect(r!.outcome).toBe("SUCCEEDED");
    expect(await stateOf(id)).toBe("EXECUTED");
  });

  it("returns null for non-EXECUTING proposals", async () => {
    const id = await seedProposal("TEMPORARY_DECLINE", 50_000);
    const r = await reconcileProposal(client, {
      proposalId: id,
      nowMs: NOW,
      outcome: "SUCCEEDED",
    });
    expect(r).toBeNull();
  });

  it("returns null for unknown proposal", async () => {
    const r = await reconcileProposal(client, {
      proposalId: "no_such",
      nowMs: NOW,
      outcome: "FAILED",
    });
    expect(r).toBeNull();
  });
});

/* ── sweep ─────────────────────────────────────────────────────── */

describe("sweepStuckExecutions", () => {
  let sweepClient: Client;

  beforeAll(async () => {
    sweepClient = createClient({ url: ":memory:" });
    await runMigrations(sweepClient);
    await saveModel(sweepClient, artifact(), "INCUMBENT");
    await sweepClient.execute({
      sql: `INSERT INTO tenants (id,name,created_at_utc) VALUES ('demo','D',?)`,
      args: [T0],
    });
  });

  it("sweeps stale EXECUTING proposals", async () => {
    const n = ++seq;
    const custId = `c_sweep_${n}`;
    const evtId = `e_sweep_${n}`;
    const propId = `p_sweep_${n}`;
    await sweepClient.execute({
      sql: `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,
              channel_responsiveness,opted_out,prior_success_count,joined_at_utc)
            VALUES (?, 'demo','C','+919000000000','c@example.test','{"25":5}',0.7,0,6,'2025-06-01')`,
      args: [custId],
    });
    await sweepClient.execute({
      sql: `INSERT INTO payment_events (id,tenant_id,customer_id,rzp_payment_id,subscription_id,
              amount_paise,failure_code,failure_class_hint,source,true_outcome_seed,occurred_at_utc,ingested_at_utc)
            VALUES (?, 'demo',?,NULL,NULL,?,?,'SOFT_RETRYABLE','SEED',NULL,'2026-02-14T09:00:00.000Z','2026-02-14T09:01:00.000Z')`,
      args: [evtId, custId, 100000, "TEMPORARY_DECLINE"],
    });
    await sweepClient.execute({
      sql: `INSERT INTO proposals (id,event_id,customer_id,model_version_id,policy_version,
              action_json,ev_paise,confidence,attributions_json,narrative,state,state_version,
              dedupe_key,created_at_utc,updated_at_utc)
            VALUES (?,?,?,?,?,?,?,?,?,NULL,'EXECUTING',0,?,?,?)`,
      args: [propId, evtId, custId, MODEL_ID, "policy-v1",
        JSON.stringify({ action: "RETRY_PAYDAY", evPaise: 100000 }),
        100000, 0.5, "[]",
        `${evtId}|${MODEL_ID}|policy-v1`, T0, "2026-02-10T00:00:00.000Z"],
    });
    await sweepClient.execute({
      sql: `INSERT INTO actions (id,proposal_id,idempotency_key,executor,payload_json,rzp_request_ref,outcome,executed_at_utc)
            VALUES (?,?,?,?,?,?,?,?)`,
      args: [`act_sweep_${n}`, propId, `idem_sweep_${n}`, "RETRY_PAYDAY", "{}", "ref", "PENDING", T0],
    });

    const count = await sweepStuckExecutions(sweepClient, NOW, 5);
    expect(count).toBe(1);
    const st = await sweepClient.execute({ sql: `SELECT state FROM proposals WHERE id=?`, args: [propId] });
    // AMBIGUOUS reconciles to FAILED terminal (state machine has no AMBIGUOUS state)
    expect(String(st.rows[0]!.state)).toBe("FAILED");
  });

  it("does not sweep recent EXECUTING proposals", async () => {
    const n = ++seq;
    const custId = `c_recent_${n}`;
    const evtId = `e_recent_${n}`;
    const propId = `p_recent_${n}`;
    await sweepClient.execute({
      sql: `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,
              channel_responsiveness,opted_out,prior_success_count,joined_at_utc)
            VALUES (?, 'demo','C','+919000000000','c@example.test','{"25":5}',0.7,0,6,'2025-06-01')`,
      args: [custId],
    });
    await sweepClient.execute({
      sql: `INSERT INTO payment_events (id,tenant_id,customer_id,rzp_payment_id,subscription_id,
              amount_paise,failure_code,failure_class_hint,source,true_outcome_seed,occurred_at_utc,ingested_at_utc)
            VALUES (?, 'demo',?,NULL,NULL,?,?,'SOFT_RETRYABLE','SEED',NULL,'2026-02-14T09:00:00.000Z','2026-02-14T09:01:00.000Z')`,
      args: [evtId, custId, 100000, "TEMPORARY_DECLINE"],
    });
    await sweepClient.execute({
      sql: `INSERT INTO proposals (id,event_id,customer_id,model_version_id,policy_version,
              action_json,ev_paise,confidence,attributions_json,narrative,state,state_version,
              dedupe_key,created_at_utc,updated_at_utc)
            VALUES (?,?,?,?,?,?,?,?,?,NULL,'EXECUTING',0,?,?,?)`,
      args: [propId, evtId, custId, MODEL_ID, "policy-v1",
        JSON.stringify({ action: "RETRY_PAYDAY", evPaise: 100000 }),
        100000, 0.5, "[]",
        `${evtId}|${MODEL_ID}|policy-v1`, T0, isoUtc(NOW)],
    });

    const count = await sweepStuckExecutions(sweepClient, NOW, 5);
    expect(count).toBe(0);
    const st = await sweepClient.execute({ sql: `SELECT state FROM proposals WHERE id=?`, args: [propId] });
    expect(String(st.rows[0]!.state)).toBe("EXECUTING");
  });
});

/* ── bulk execution ────────────────────────────────────────────── */

describe("executeAll", () => {
  it("executes all APPROVED/AUTO_APPROVED proposals", async () => {
    const id1 = await seedProposal("INSUFFICIENT_FUNDS", 300_000);
    const id2 = await seedAutoApproved("TEMPORARY_DECLINE", 150_000);
    const result = await executeAll(client, NOW);
    expect(result.executed).toBeGreaterThanOrEqual(2);
    expect(result.succeeded).toBeGreaterThanOrEqual(1);
    expect(await stateOf(id1)).toBe("EXECUTED");
    expect(await stateOf(id2)).toBe("EXECUTED");
  });
});

/* ── full lifecycle integration ────────────────────────────────── */

describe("full lifecycle: approve → execute → audit", () => {
  it("approveProposal + executeProposal end-to-end", async () => {
    const id = await seedProposal("INSUFFICIENT_FUNDS", 250_000);
    await client.execute({
      sql: `UPDATE proposals SET state='AWAITING_APPROVAL' WHERE id=?`,
      args: [id],
    });
    expect(await stateOf(id)).toBe("AWAITING_APPROVAL");

    const a = await approveProposal(client, id, { actor: "merchant@demo" });
    expect(a.ok).toBe(true);
    expect(await stateOf(id)).toBe("APPROVED");

    const e = await executeProposal(client, { proposalId: id, nowMs: NOW });
    expect(e.outcome).toBe("SUCCEEDED");
    expect(await stateOf(id)).toBe("EXECUTED");

    const audit = await client.execute({
      sql: `SELECT entry_type, payload_json FROM audit_log
            WHERE event_id IN (SELECT event_id FROM proposals WHERE id=?)
            ORDER BY ts_utc ASC`,
      args: [id],
    });
    const types = audit.rows.map((r) => String(r.entry_type));
    expect(types).toContain("ACTION");
  });
});
