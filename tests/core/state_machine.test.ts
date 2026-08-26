import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import {
  ALLOWED_TRANSITIONS,
  transition,
  isLegalTransition,
} from "../../packages/core/src/approval/state_machine.js";
import {
  approveProposal,
  rejectProposal,
  cancelProposal,
  batchApprove,
} from "../../packages/core/src/approval/actions.js";

let client: Client;
const T0 = "2026-02-01T00:00:00.000Z";
const ALL_STATES = Object.keys(ALLOWED_TRANSITIONS) as Array<keyof typeof ALLOWED_TRANSITIONS>;

async function mkProposal(id: string, state: string) {
  const custId = `cust_${id}`;
  const evtId = `evt_${id}`;
  await client.execute({
    sql: `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,joined_at_utc)
          VALUES (?,'demo','X','+919000000000','x@example.test',?)`,
    args: [custId, T0],
  });
  await client.execute({
    sql: `INSERT INTO payment_events (id,tenant_id,customer_id,amount_paise,failure_code,
            source,occurred_at_utc,ingested_at_utc)
          VALUES (?,'demo',?,49900,'INSUFFICIENT_FUNDS','SEED',?,?)`,
    args: [evtId, custId, T0, T0],
  });
  await client.execute({
    sql: `INSERT INTO proposals (id,event_id,customer_id,model_version_id,policy_version,
            action_json,ev_paise,confidence,state,state_version,dedupe_key,created_at_utc,updated_at_utc)
          VALUES (?,?,?,?,?,'{"action":"NO_ACTION"}',0,0.5,?,0,?,?,?)`,
    args: [id, evtId, custId, "mv_test", "policy-v1", state, `dk_${id}`, T0, T0],
  });
}

beforeAll(async () => {
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
  await client.execute({
    sql: `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,joined_at_utc)
          VALUES ('cust_x','demo','X','+919000000000','x@example.test',?)`,
    args: [T0],
  });
  await client.execute({
    sql: `INSERT INTO payment_events (id,tenant_id,customer_id,amount_paise,failure_code,
            source,occurred_at_utc,ingested_at_utc)
          VALUES ('evt_x','demo','cust_x',49900,'INSUFFICIENT_FUNDS','SEED',?,?)`,
    args: [T0, T0],
  });
});

describe("transition legality map", () => {
  it("terminal states allow nothing out", () => {
    for (const s of ["EXECUTED", "FAILED", "CANCELLED", "EDITED", "REJECTED"]) {
      expect(ALLOWED_TRANSITIONS[s as keyof typeof ALLOWED_TRANSITIONS]).toEqual([]);
    }
  });

  it("every illegal jump is rejected; every legal jump succeeds", async () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        const id = `p_${from}_${to}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
        await mkProposal(id, from);
        const legal = isLegalTransition(from, to);
        const r = await transition(client, { proposalId: id, toState: to, actor: "merchant@demo" });
        expect(r.ok, `${from}→${to} expected ${legal}`).toBe(legal);
        if (!legal && !isLegalTransition(from, to)) {
          expect(["ILLEGAL_TRANSITION", "TERMINAL_STATE"]).toContain(r.reason);
        }
      }
    }
  });

  it("unknown proposal fails closed", async () => {
    const r = await transition(client, { proposalId: "ghost", toState: "APPROVED", actor: "x" });
    expect(r).toMatchObject({ ok: false, reason: "UNKNOWN_PROPOSAL" });
  });
});

describe("optimistic locking", () => {
  it("double approve ⇒ exactly one effect (P4-B1)", async () => {
    await mkProposal("p_race1", "AWAITING_APPROVAL");
    const a = await approveProposal(client, "p_race1", { actor: "merchant@demo" });
    expect(a.ok).toBe(true);
    const b = await approveProposal(client, "p_race1", { actor: "merchant@demo" });
    expect(b.ok).toBe(false);
    expect(["TERMINAL_STATE", "ILLEGAL_TRANSITION"]).toContain(b.reason);

    const records = await client.execute({
      sql: `SELECT count(*) n FROM approval_records WHERE proposal_id='p_race1'`,
    });
    expect(records.rows[0]!.n).toBe(1);
  });

  it("stale state_version write affects zero rows (P4-B2)", async () => {
    await mkProposal("p_stale", "AWAITING_APPROVAL");
    await client.execute({
      sql: `UPDATE proposals SET state='APPROVED', state_version=state_version+1 WHERE id='p_stale'`,
    });
    const r = await transition(client, { proposalId: "p_stale", toState: "REJECTED", actor: "x" });
    expect(r.ok).toBe(false);
  });

  it("each successful transition bumps state_version and ledgers an APPROVAL row", async () => {
    await mkProposal("p_ledger", "AWAITING_APPROVAL");
    await approveProposal(client, "p_ledger", { actor: "merchant@demo", note: "looks good" });
    const row = (
      await client.execute({ sql: `SELECT state_version FROM proposals WHERE id='p_ledger'` })
    ).rows[0]!;
    expect(Number(row.state_version)).toBe(1);

    const ledger = await client.execute({
      sql: `SELECT payload_json FROM audit_log WHERE entry_type='APPROVAL'
            AND payload_json LIKE '%p_ledger%'`,
    });
    const payloads = ledger.rows.map((r) => JSON.parse(String(r.payload_json)));
    expect(payloads.some((p) => p.from === "AWAITING_APPROVAL" && p.to === "APPROVED")).toBe(true);
    expect(payloads[0].note).toBe("looks good");
  });
});

describe("human actions", () => {
  it("reject records decision REJECT with honest actor label", async () => {
    await mkProposal("p_rej", "AWAITING_APPROVAL");
    const r = await rejectProposal(client, "p_rej", { actor: "merchant@demo", note: "too risky" });
    expect(r.ok).toBe(true);
    const rec = (
      await client.execute({ sql: `SELECT * FROM approval_records WHERE proposal_id='p_rej'` })
    ).rows[0]!;
    expect(rec.decision).toBe("REJECT");
    expect(rec.actor).toBe("merchant@demo");
  });

  it("cancel allowed pre-execution, refused after EXECUTED", async () => {
    await mkProposal("p_can1", "AUTO_APPROVED");
    expect((await cancelProposal(client, "p_can1", "paid elsewhere")).ok).toBe(true);

    await mkProposal("p_can2", "EXECUTED");
    expect((await cancelProposal(client, "p_can2", "late")).reason).toBe("TERMINAL_STATE");
  });

  it("batch approve reports per-item results and skips non-awaiting rows (P4-B4)", async () => {
    await mkProposal("p_b1", "AWAITING_APPROVAL");
    await mkProposal("p_b2", "AWAITING_APPROVAL");
    await mkProposal("p_b3", "PROPOSED");

    const s = await batchApprove(client, ["p_b1", "p_b2", "p_b3", "p_b2"], {
      actor: "merchant@demo",
    });
    expect(s.approved).toBe(2);
    expect(s.skipped).toBe(2);
    const byId = new Map(s.items.map((i) => [i.proposalId, i]));
    expect(byId.get("p_b3")!.reason).toBe("ILLEGAL_TRANSITION");
    expect(byId.get("p_b2")!.reason).toBe("ILLEGAL_TRANSITION");
  });
});
