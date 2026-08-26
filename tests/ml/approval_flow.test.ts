import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { defaultPolicy } from "../../packages/core/src/decide/policy.js";
import {
  setTenantEnvelope,
  getTenantEnvelope,
  listApprovalQueue,
} from "../../packages/core/src/approval";
import { approveProposal } from "../../packages/core/src/approval/actions.js";
import type { AutonomyEnvelope } from "../../packages/core/src/approval/envelope.js";
import { processEvent, editProposal } from "../../packages/ml/src/pipeline.js";
import { saveModel } from "../../packages/ml/src/registry.js";
import { buildArtifact } from "../../packages/ml/src/artifact.js";
import { FEATURE_NAMES } from "../../packages/ml/src/features.js";

let client: Client;
const NOW = Date.UTC(2026, 1, 16, 10, 0, 0);
const T0 = "2026-01-05T09:00:00.000Z";
const POLICY = defaultPolicy();

const LINK_ENVELOPE: AutonomyEnvelope = {
  envelope_version: "env-v1",
  enabled: true,
  classes: ["SOFT_RETRYABLE", "NETWORK_TIMEOUT"],
  channels: ["RETRY_NOW", "RETRY_PAYDAY", "REMINDER_LINK", "ALTERNATE_UPI_LINK"],
  max_attempts: 5,
  max_amount_paise: 100_000,
  require_quiet_ok: true,
};

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

async function seedCustomerEvent(id: string, code: string, amountPaise: number) {
  await client.execute({
    sql: `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,
            channel_responsiveness,opted_out,prior_success_count,joined_at_utc)
          VALUES (?, 'demo','C','+919000000000','c@example.test','{"25":5}',0.7,0,6,'2025-06-01')`,
    args: [`c_${id}`],
  });
  await client.execute({
    sql: `INSERT INTO payment_events (id,tenant_id,customer_id,rzp_payment_id,subscription_id,
            amount_paise,failure_code,failure_class_hint,source,true_outcome_seed,occurred_at_utc,ingested_at_utc)
          VALUES (?, 'demo',?,NULL,NULL,?,?,'SOFT_RETRYABLE','SEED',NULL,
            '2026-02-14T09:00:00.000Z','2026-02-14T09:01:00.000Z')`,
    args: [id, `c_${id}`, amountPaise, code],
  });
}

async function stateOf(proposalId: string): Promise<string> {
  const r = await client.execute({
    sql: `SELECT state FROM proposals WHERE id=?`,
    args: [proposalId],
  });
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
});

describe("auto-approve envelope integration (P4)", () => {
  it("deny-by-default: empty tenant envelope keeps everything awaiting (P4-B3)", async () => {
    await seedCustomerEvent("e_deny", "INSUFFICIENT_FUNDS", 49_900);
    const r = await processEvent(client, "e_deny", { policy: POLICY, nowMs: NOW });
    expect(r.status).toBe("PROPOSED");
    expect(await stateOf(r.proposalId!)).toBe("AWAITING_APPROVAL");

    const ledger = await client.execute({
      sql: `SELECT payload_json FROM audit_log WHERE event_id='e_deny' AND entry_type='DECISION'`,
    });
    const p = JSON.parse(String(ledger.rows[0]!.payload_json));
    expect(p.autoApproved).toBe(false);
    expect(p.envelopeReasons).toContain("ENVELOPE_DISABLED");
  });

  it("in-envelope soft failure ⇒ AUTO_APPROVED without a human click", async () => {
    await setTenantEnvelope(client, "demo", LINK_ENVELOPE);
    await seedCustomerEvent("e_auto", "TEMPORARY_DECLINE", 49_900);
    const r = await processEvent(client, "e_auto", { policy: POLICY, nowMs: NOW });
    expect(await stateOf(r.proposalId!)).toBe("AUTO_APPROVED");
  });

  it("amount over cap falls back to AWAITING_APPROVAL with reasons", async () => {
    await setTenantEnvelope(client, "demo", { ...LINK_ENVELOPE, max_amount_paise: 20_000 });
    await seedCustomerEvent("e_cap", "TEMPORARY_DECLINE", 49_900);
    const r = await processEvent(client, "e_cap", { policy: POLICY, nowMs: NOW });
    expect(await stateOf(r.proposalId!)).toBe("AWAITING_APPROVAL");
    const ledger = await client.execute({
      sql: `SELECT payload_json FROM audit_log WHERE event_id='e_cap' AND entry_type='DECISION'`,
    });
    const p = JSON.parse(String(ledger.rows[0]!.payload_json));
    expect(p.envelopeReasons).toContain("AMOUNT_OVER_CAP");
  });

  it("corrupt envelope ⇒ deny-all + alarm row, pipeline unaffected", async () => {
    await client.execute({
      sql: `UPDATE tenants SET autonomy_envelope_json='{oops' WHERE id='demo'`,
    });
    await seedCustomerEvent("e_corrupt", "TEMPORARY_DECLINE", 49_900);
    const r = await processEvent(client, "e_corrupt", { policy: POLICY, nowMs: NOW });
    expect(await stateOf(r.proposalId!)).toBe("AWAITING_APPROVAL");
    const alarms = await client.execute({
      sql: `SELECT count(*) n FROM audit_log WHERE payload_json LIKE '%ENVELOPE_CORRUPT%'`,
    });
    expect(Number(alarms.rows[0]!.n)).toBeGreaterThanOrEqual(1);
    const envCheck = await getTenantEnvelope(client, "demo");
    expect(envCheck.corrupted).toBe(true);
  });
});

describe("edit recycles through decide + envelope (P4-B6)", () => {
  it("redirects an awaiting proposal to another feasible action as a NEW proposal", async () => {
    await setTenantEnvelope(client, "demo", { ...LINK_ENVELOPE, max_amount_paise: 10_000 });
    await seedCustomerEvent("e_edit", "INSUFFICIENT_FUNDS", 30_000);
    const first = await processEvent(client, "e_edit", { policy: POLICY, nowMs: NOW });
    const originalId = first.proposalId!;
    expect(await stateOf(originalId)).toBe("AWAITING_APPROVAL");

    const out = await editProposal(
      client,
      originalId,
      "REMINDER_LINK",
      { actor: "merchant@demo", note: "prefer soft nudge" },
    );
    expect(out.ok).toBe(true);
    expect(await stateOf(originalId)).toBe("EDITED");

    const newRow = (
      await client.execute({ sql: `SELECT * FROM proposals WHERE id=?`, args: [out.newProposalId!] })
    ).rows[0]!;
    const action = JSON.parse(String(newRow.action_json)) as { action: string };
    expect(action.action).toBe("REMINDER_LINK");
    expect(newRow.state).toBe("AWAITING_APPROVAL");
    expect(newRow.dedupe_key).not.toBe(
      (await client.execute({ sql: `SELECT dedupe_key FROM proposals WHERE id=?`, args: [originalId] }))
        .rows[0]!.dedupe_key,
    );

    const approval = await client.execute({
      sql: `SELECT decision FROM approval_records WHERE proposal_id=?`,
      args: [originalId],
    });
    expect(approval.rows[0]!.decision).toBe("EDIT");
  });

  it("refuses infeasible redirects and leaves the original untouched", async () => {
    await setTenantEnvelope(client, "demo", LINK_ENVELOPE);
    await seedCustomerEvent("e_infeasible", "SUSPECTED_FRAUD", 19_900);
    const r = await processEvent(client, "e_infeasible", { policy: POLICY, nowMs: NOW });
    const originalId = r.proposalId!;

    const out = await editProposal(client, originalId, "RETRY_NOW", { actor: "merchant@demo" });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("ACTION_INFEASIBLE");
    expect(out.violatedRules!.length).toBeGreaterThan(0);
    expect(await stateOf(originalId)).not.toBe("EDITED");
  });

  it("edited proposals cannot be edited again — recycle only from awaiting", async () => {
    await setTenantEnvelope(client, "demo", { ...LINK_ENVELOPE, max_amount_paise: 10_000 });
    await seedCustomerEvent("e_edit2", "TEMPORARY_DECLINE", 25_000);
    const r = await processEvent(client, "e_edit2", { policy: POLICY, nowMs: NOW });
    const id1 = r.proposalId!;
    const out = await editProposal(client, id1, "REMINDER_LINK", { actor: "merchant@demo" });
    expect(out.ok).toBe(true);
    const again = await editProposal(client, id1, "RETRY_PAYDAY", { actor: "merchant@demo" });
    expect(again.ok).toBe(false);
    expect(again.reason).toBe("NOT_AWAITING_APPROVAL");
  });

  it("approve → APPROVED shows up as executable state; queue shrinks", async () => {
    await seedCustomerEvent("e_q", "TEMPORARY_DECLINE", 49_900);
    await setTenantEnvelope(client, "demo", { ...LINK_ENVELOPE, max_amount_paise: 10_000 });
    const r = await processEvent(client, "e_q", { policy: POLICY, nowMs: NOW });
    const id = r.proposalId!;
    expect(await stateOf(id)).toBe("AWAITING_APPROVAL");

    const before = await listApprovalQueue(client);
    expect(before.some((q) => q.proposalId === id)).toBe(true);

    const a = await approveProposal(client, id, { actor: "merchant@demo" });
    expect(a.ok).toBe(true);
    expect(await stateOf(id)).toBe("APPROVED");

    const after = await listApprovalQueue(client);
    expect(after.some((q) => q.proposalId === id)).toBe(false);
  });
});
