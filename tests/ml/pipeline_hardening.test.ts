import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { defaultPolicy } from "../../packages/core/src/decide/policy.js";
import { processEvent, editProposal } from "../../packages/ml/src/pipeline.js";
import { saveModel } from "../../packages/ml/src/registry.js";
import { buildArtifact } from "../../packages/ml/src/artifact.js";
import { FEATURE_NAMES } from "../../packages/ml/src/features.js";

let client: Client;
const NOW = Date.UTC(2026, 1, 16, 10, 0, 0);
const T0 = "2026-01-05T09:00:00.000Z";
const POLICY = defaultPolicy();

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

async function seedOptedOutRisky(id: string) {
  await client.execute({
    sql: `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,
            channel_responsiveness,opted_out,prior_success_count,joined_at_utc)
          VALUES (?,'demo','C','+919000000000','c@example.test','{"25":5}',0.7,1,6,'2025-06-01')`,
    args: [`c_${id}`],
  });
  await client.execute({
    sql: `INSERT INTO payment_events (id,tenant_id,customer_id,rzp_payment_id,subscription_id,
            amount_paise,failure_code,failure_class_hint,source,true_outcome_seed,occurred_at_utc,ingested_at_utc)
          VALUES (?,'demo',?,NULL,NULL,19900,'SUSPECTED_FRAUD','RISK_FLAGGED','SEED',
            NULL,'2026-02-14T09:00:00.000Z','2026-02-14T09:01:00.000Z')`,
    args: [id, `c_${id}`],
  });
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

describe("pipeline hardening", () => {
  it("NO_ACTION proposals stay out of the approval queue but keep full provenance", async () => {
    await seedOptedOutRisky("e_na");
    const r = await processEvent(client, "e_na", { policy: POLICY, nowMs: NOW });
    expect(r.status).toBe("PROPOSED");
    expect(r.chosenAction).toBe("NO_ACTION");

    const row = (
      await client.execute({ sql: `SELECT state FROM proposals WHERE id=?`, args: [r.proposalId!] })
    ).rows[0]!;
    expect(String(row.state)).toBe("PROPOSED");

    const queue = await client.execute({
      sql: `SELECT count(*) n FROM proposals WHERE id=? AND state='AWAITING_APPROVAL'`,
      args: [r.proposalId!],
    });
    expect(Number(queue.rows[0]!.n)).toBe(0);

    const ledger = await client.execute({
      sql: `SELECT payload_json FROM audit_log WHERE event_id='e_na' AND entry_type='DECISION'`,
    });
    const p = JSON.parse(String(ledger.rows[0]!.payload_json)) as Record<string, unknown>;
    expect(p.fallbackReason).toMatch(/ALL_ACTIONS_CONSTRAINED/);
    expect(p.autoApproved).toBe(false);
  });

  it("frozen-feature drift refuses processing instead of overwriting history (I-3/I-4)", async () => {
    await client.execute({
      sql: `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,
              channel_responsiveness,opted_out,prior_success_count,joined_at_utc)
            VALUES ('c_drift','demo','C','+919000000000','c@example.test','{"25":5}',0.7,0,6,'2025-06-01')`,
    });
    await client.execute({
      sql: `INSERT INTO payment_events (id,tenant_id,customer_id,rzp_payment_id,subscription_id,
              amount_paise,failure_code,failure_class_hint,source,true_outcome_seed,occurred_at_utc,ingested_at_utc)
            VALUES ('e_drift','demo','c_drift',NULL,NULL,29900,'TEMPORARY_DECLINE','SOFT_RETRYABLE','SEED',
              NULL,'2026-02-14T10:00:00.000Z','2026-02-14T10:01:00.000Z')`,
    });
    await client.execute({
      sql: `INSERT INTO features (id,event_id,feature_version,vector_json,computed_at_utc)
            VALUES ('feat/tampered','e_drift','feat-v1','[9,9,9,9,9,9,9,9,9,9,9]',?)`,
      args: ["2026-01-01T00:00:00.000Z"],
    });

    await expect(
      processEvent(client, "e_drift", { policy: POLICY, nowMs: NOW }),
    ).rejects.toThrow(/drift/);

    const proposals = await client.execute({
      sql: `SELECT count(*) n FROM proposals WHERE event_id='e_drift'`,
    });
    expect(Number(proposals.rows[0]!.n)).toBe(0);

    const frozen = await client.execute({
      sql: `SELECT vector_json FROM features WHERE event_id='e_drift'`,
    });
    expect(String(frozen.rows[0]!.vector_json)).toBe("[9,9,9,9,9,9,9,9,9,9,9]");
  });

  it("editProposal fails closed on unknown proposal without side effects", async () => {
    const out = await editProposal(client, "prop_ghost", "RETRY_NOW", { actor: "merchant@demo" });
    expect(out).toEqual({ ok: false, reason: "UNKNOWN_PROPOSAL" });
  });

  it("editProposal on an already-approved proposal is refused (only awaiting edits)", async () => {
    await client.execute({
      sql: `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,
              channel_responsiveness,opted_out,prior_success_count,joined_at_utc)
            VALUES ('c_appr','demo','C','+919000000000','c@example.test','{"25":5}',0.7,0,6,'2025-06-01')`,
    });
    await client.execute({
      sql: `INSERT INTO payment_events (id,tenant_id,customer_id,rzp_payment_id,subscription_id,
              amount_paise,failure_code,failure_class_hint,source,true_outcome_seed,occurred_at_utc,ingested_at_utc)
            VALUES ('e_appr','demo','c_appr',NULL,NULL,29900,'TEMPORARY_DECLINE','SOFT_RETRYABLE','SEED',
              NULL,'2026-02-14T11:00:00.000Z','2026-02-14T11:01:00.000Z')`,
    });
    const r = await processEvent(client, "e_appr", { policy: POLICY, nowMs: NOW });
    const id = r.proposalId!;
    const { approveProposal } = await import("../../packages/core/src/approval/actions.js");
    await approveProposal(client, id, { actor: "merchant@demo" });

    const out = await editProposal(client, id, "REMINDER_LINK", { actor: "merchant@demo" });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("NOT_AWAITING_APPROVAL");

    const edits = await client.execute({
      sql: `SELECT count(*) n FROM proposals WHERE id LIKE '${id}_edit%'`,
    });
    expect(Number(edits.rows[0]!.n)).toBe(0);
  });
});
