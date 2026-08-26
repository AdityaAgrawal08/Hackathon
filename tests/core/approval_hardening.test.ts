import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { transition } from "../../packages/core/src/approval/state_machine.js";
import {
  approveProposal,
  rejectProposal,
} from "../../packages/core/src/approval/actions.js";
import { listApprovalQueue } from "../../packages/core/src/approval/queue.js";

let client: Client;
const T0 = "2026-02-01T00:00:00.000Z";

async function mkAwaiting(id: string) {
  const custId = `hc_${id}`;
  await client.execute({
    sql: `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,joined_at_utc)
          VALUES (?,'demo','H','+919000000000','h@example.test',?)`,
    args: [custId, T0],
  });
  await client.execute({
    sql: `INSERT INTO payment_events (id,tenant_id,customer_id,amount_paise,failure_code,
            source,occurred_at_utc,ingested_at_utc)
          VALUES (?, 'demo',?,49900,'INSUFFICIENT_FUNDS','SEED',?,?)`,
    args: [`he_${id}`, custId, T0, T0],
  });
  await client.execute({
    sql: `INSERT INTO proposals (id,event_id,customer_id,model_version_id,policy_version,
            action_json,ev_paise,confidence,state,state_version,dedupe_key,created_at_utc,updated_at_utc)
          VALUES (?,?,?,?,?,'{"action":"RETRY_PAYDAY"}',100,0.5,'AWAITING_APPROVAL',0,?,?,?)`,
    args: [id, `he_${id}`, custId, "mv_h", "policy-v1", `dk_${id}`, T0, T0],
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
          VALUES ('mv_h','logreg','{}','sha','ds','[]','{}',?,'CANDIDATE')`,
    args: [T0],
  });
});

describe("approval hardening", () => {
  it("blank actors are rejected before any write (audit trail integrity)", async () => {
    await mkAwaiting("ha1");
    for (const bad of ["", "   "]) {
      await expect(approveProposal(client, "ha1", { actor: bad })).rejects.toThrow(/actor/);
      await expect(
        transition(client, { proposalId: "ha1", toState: "APPROVED", actor: bad }),
      ).rejects.toThrow(/actor/);
    }
    const r = await client.execute({ sql: `SELECT state FROM proposals WHERE id='ha1'` });
    expect(String(r.rows[0]!.state)).toBe("AWAITING_APPROVAL");
  });

  it("unknown target states throw instead of writing garbage rows", async () => {
    await mkAwaiting("ha2");
    await expect(
      transition(client, {
        proposalId: "ha2",
        toState: "MONEY_PRINTER" as never,
        actor: "merchant@demo",
      }),
    ).rejects.toThrow(/unknown target state/);
  });

  it("queue limit must be a sane positive integer", async () => {
    for (const bad of [0, -5, 1.5]) {
      await expect(listApprovalQueue(client, bad)).rejects.toThrow(/limit/);
    }
    const ok = await listApprovalQueue(client, 1);
    expect(ok.length).toBeLessThanOrEqual(1);
  });

  it("reject still records honest actor + note after prior rejection attempt failed", async () => {
    await mkAwaiting("ha3");
    await rejectProposal(client, "ha3", { actor: "merchant@demo", note: "suspected abuse" });
    const rec = (
      await client.execute({ sql: `SELECT * FROM approval_records WHERE proposal_id='ha3'` })
    ).rows[0]!;
    expect(rec.actor).toBe("merchant@demo");
    expect(rec.decision).toBe("REJECT");
    expect(rec.note).toBe("suspected abuse");
    const second = await rejectProposal(client, "ha3", { actor: "merchant@demo" });
    expect(second.ok).toBe(false);
    const count = await client.execute({
      sql: `SELECT count(*) n FROM approval_records WHERE proposal_id='ha3'`,
    });
    expect(Number(count.rows[0]!.n)).toBe(1);
  });
});
