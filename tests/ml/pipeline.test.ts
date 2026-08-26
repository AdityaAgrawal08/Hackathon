import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import {
  defaultPolicy,
  type PolicyPack,
} from "../../packages/core/src/decide/policy.js";
import {
  processEvent,
  proposeForCorpus,
} from "../../packages/ml/src/pipeline.js";
import { saveModel } from "../../packages/ml/src/registry.js";
import { buildArtifact } from "../../packages/ml/src/artifact.js";
import { computeFeatures, FEATURE_NAMES } from "../../packages/ml/src/features.js";
import { scoreWithArtifact } from "../../packages/ml/src/predict.js";

let client: Client;
const NOW = Date.UTC(2026, 1, 15, 10, 0, 0);
const T0 = "2026-01-05T09:00:00.000Z";

async function seedRow(sql: string, args: unknown[]) {
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

  await seedRow(
    `INSERT INTO tenants (id,name,created_at_utc) VALUES ('demo','Demo',?)`,
    [T0],
  );
  for (const c of [
    { id: "cust_ok", opted: 0, pattern: '{"25":4,"26":2}', resp: 0.7 },
    { id: "cust_optedout", opted: 1, pattern: '{"10":3}', resp: 0.5 },
    { id: "cust_thin", opted: 0, pattern: '{"28":2}', resp: 0.4 },
  ]) {
    await seedRow(
      `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,
        channel_responsiveness,opted_out,prior_success_count,joined_at_utc)
       VALUES (?,'demo','X','+919000000000','x@example.test',?,?,?,5,?)`,
      [c.id, c.pattern, c.resp, c.opted, "2025-06-01T00:00:00.000Z"],
    );
  }
  const events = [
    { id: "evt_soft", cust: "cust_ok", code: "INSUFFICIENT_FUNDS", src: "SEED", amt: 49_900, at: "2026-02-14T09:00:00.000Z" },
    { id: "evt_prior", cust: "cust_ok", code: "GATEWAY_TIMEOUT", src: "SEED", amt: 30_000, at: "2026-01-20T09:00:00.000Z" },
    { id: "evt_risk_optout", cust: "cust_optedout", code: "SUSPECTED_FRAUD", src: "SEED", amt: 19_900, at: "2026-02-01T09:00:00.000Z" },
    { id: "evt_training", cust: "cust_ok", code: "CARD_EXPIRED", src: "TRAINING", amt: 29_900, at: "2026-02-02T09:00:00.000Z" },
    { id: "evt_orphan", cust: null, code: "TOKEN_INVALID", src: "WEBHOOK", amt: 39_900, at: "2026-02-03T09:00:00.000Z" },
  ];
  for (const e of events) {
    await seedRow(
      `INSERT INTO payment_events (id,tenant_id,customer_id,rzp_payment_id,subscription_id,
        amount_paise,failure_code,failure_class_hint,source,true_outcome_seed,occurred_at_utc,ingested_at_utc)
       VALUES (?,'demo',?,NULL,NULL,?,?,'SOFT_RETRYABLE',?,NULL,?,?)`,
      [e.id, e.cust, e.amt, e.code, e.src, e.at, T0],
    );
  }
});

const policy: PolicyPack = defaultPolicy();

describe("decision pipeline (PREDICT→DECIDE→PROPOSE)", () => {
  it("skips TRAINING-sourced events", async () => {
    const r = await processEvent(client, "evt_training", { policy, nowMs: NOW });
    expect(r.status).toBe("SKIPPED_TRAINING");
  });

  it("skips events without a resolved customer (fail closed)", async () => {
    const r = await processEvent(client, "evt_orphan", { policy, nowMs: NOW });
    expect(r.status).toBe("SKIPPED_UNRESOLVED_CUSTOMER");
  });

  it("produces a proposal whose confidence matches the model exactly", async () => {
    const r = await processEvent(client, "evt_soft", { policy, nowMs: NOW });
    expect(r.status).toBe("PROPOSED");
    expect(r.proposalId).toBeDefined();

    const expected = (() => {
      const computed = computeFeatures({
        failureCode: "INSUFFICIENT_FUNDS",
        amountPaise: 49_900,
        occurredAtUtc: "2026-02-14T09:00:00.000Z",
        priorFailureAmountsPaise: [30_000, 29_900],
        priorFailureCount: 2,
        customer: {
          paydayPattern: { "25": 4, "26": 2 },
          channelResponsiveness: 0.7,
          priorSuccessCount: 5,
          joinedAtUtc: "2025-06-01T00:00:00.000Z",
        },
      });
      return scoreWithArtifact(computed.values, artifact()).probability;
    })();

    const row = (
      await client.execute({
        sql: `SELECT * FROM proposals WHERE event_id='evt_soft'`,
      })
    ).rows[0]!;
    expect(row.state).toBe("AWAITING_APPROVAL");
    expect(row.confidence).toBeCloseTo(expected, 15);
    expect(row.model_version_id).toBe(artifact().id);
    expect(row.dedupe_key).toBe(`evt_soft|${artifact().id}|policy-v1`);
    const attrs = JSON.parse(String(row.attributions_json)) as unknown[];
    expect(attrs.length).toBeLessThanOrEqual(5);
    const action = JSON.parse(String(row.action_json)) as { action: string; evPaise: number };
    expect(action.evPaise).toBe(Number(row.ev_paise));
    expect(action.action).toBe(r.chosenAction);
  });

  it("freezes features and writes exactly one DECISION ledger row per proposal", async () => {
    const feat = await client.execute({
      sql: `SELECT vector_json FROM features WHERE event_id='evt_soft'`,
    });
    expect(feat.rows.length).toBe(1);

    const ledger = await client.execute({
      sql: `SELECT payload_json FROM audit_log WHERE event_id='evt_soft' AND entry_type='DECISION'`,
    });
    expect(ledger.rows.length).toBe(1);
    const payload = JSON.parse(String(ledger.rows[0]!.payload_json)) as Record<string, unknown>;
    expect(payload.chosenAction).toBeDefined();
    expect(payload.modelVersionId).toBe(artifact().id);
  });

  it("replaying the same event is a DUPLICATE with no new rows", async () => {
    const before = await client.execute(`SELECT count(*) n FROM proposals`);
    const r = await processEvent(client, "evt_soft", { policy, nowMs: NOW + 1000 });
    expect(r.status).toBe("DUPLICATE");
    const after = await client.execute(`SELECT count(*) n FROM proposals`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("fully-constrained customer still gets a NO_ACTION proposal (P3-B4 gate)", async () => {
    const r = await processEvent(client, "evt_risk_optout", { policy, nowMs: NOW });
    expect(r.status).toBe("PROPOSED");
    expect(r.chosenAction).toBe("NO_ACTION");

    const ledger = await client.execute({
      sql: `SELECT payload_json FROM audit_log WHERE event_id='evt_risk_optout' AND entry_type='DECISION'`,
    });
    const payload = JSON.parse(String(ledger.rows[0]!.payload_json)) as {
      fallbackReason: string;
      refusals: Array<{ violatedRules: string[] }>;
    };
    expect(payload.fallbackReason).toMatch(/^ALL_ACTIONS_CONSTRAINED:/);
    expect(payload.refusals.length).toBeGreaterThan(0);
  });

  it("second failure for a customer with an open proposal waits its turn (P5-B8)", async () => {
    await seedRow(
      `INSERT INTO payment_events (id,tenant_id,customer_id,rzp_payment_id,subscription_id,
        amount_paise,failure_code,failure_class_hint,source,true_outcome_seed,occurred_at_utc,ingested_at_utc)
       VALUES ('evt_soft2','demo','cust_ok',NULL,NULL,59900,'TEMPORARY_DECLINE','SOFT_RETRYABLE','SEED',
        NULL,'2026-02-20T09:00:00.000Z','2026-02-20T09:01:00.000Z')`,
      [],
    );
    const r = await processEvent(client, "evt_soft2", { policy, nowMs: NOW + 2000 });
    expect(r.status).toBe("SKIPPED_OPEN_PROPOSAL");
    const prior = await client.execute({
      sql: `SELECT state FROM proposals WHERE event_id='evt_soft'`,
    });
    expect(prior.rows[0]!.state).toBe("AWAITING_APPROVAL");
    const count = await client.execute({
      sql: `SELECT count(*) n FROM proposals WHERE event_id='evt_soft2'`,
    });
    expect(count.rows[0]!.n).toBe(0);
  });

  it("batch is idempotent end-to-end on fresh fixtures", async () => {
    for (const c of [
      { id: "cust_b1", pattern: '{"27":5}', resp: 0.8 },
      { id: "cust_b2", pattern: '{"26":3,"28":3}', resp: 0.6 },
    ]) {
      await seedRow(
        `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,
          channel_responsiveness,opted_out,prior_success_count,joined_at_utc)
         VALUES (?,'demo','B','+919000000000','b@example.test',?,?,0,5,'2025-06-01')`,
        [c.id, c.pattern, c.resp],
      );
    }
    for (const e of [
      { id: "evt_batch1", cust: "cust_b1", code: "INSUFFICIENT_FUNDS", at: "2026-02-05T09:00:00.000Z" },
      { id: "evt_batch2", cust: "cust_b2", code: "NETWORK_ERROR", at: "2026-02-06T09:00:00.000Z" },
    ]) {
      await seedRow(
        `INSERT INTO payment_events (id,tenant_id,customer_id,rzp_payment_id,subscription_id,
          amount_paise,failure_code,failure_class_hint,source,true_outcome_seed,occurred_at_utc,ingested_at_utc)
         VALUES (?,'demo',?,NULL,NULL,44900,?,'SOFT_RETRYABLE','SEED',NULL,?,?)`,
        [e.id, e.cust, e.code, e.at, T0],
      );
    }

    const first = await proposeForCorpus(client, { policy, nowMs: NOW });
    expect(first.proposed).toBe(2);

    const second = await proposeForCorpus(client, { policy, nowMs: NOW });
    expect(second.proposed).toBe(0);
    expect(second.duplicates).toBeGreaterThanOrEqual(2);
  });

  it("throws on an unknown event id (caller bug, fail loud)", async () => {
    await expect(
      processEvent(client, "evt_never_inserted", { policy, nowMs: NOW }),
    ).rejects.toThrow(/unknown event/);
  });

  it("returns NO_INCUMBENT instead of guessing on a model-less DB", async () => {
    const fresh = createClient({ url: ":memory:" });
    await runMigrations(fresh);
    await fresh.execute({
      sql: `INSERT INTO tenants (id,name,created_at_utc) VALUES ('demo','D','2026-01-01')`,
    });
    await fresh.execute({
      sql: `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,joined_at_utc)
            VALUES ('c1','demo','X','+919000000000','x@example.test','2025-06-01')`,
    });
    await fresh.execute({
      sql: `INSERT INTO payment_events (id,tenant_id,customer_id,amount_paise,failure_code,
              source,occurred_at_utc,ingested_at_utc)
            VALUES ('e1','demo','c1',49900,'INSUFFICIENT_FUNDS','SEED',
              '2026-02-14T09:00:00.000Z','2026-02-14T09:01:00.000Z')`,
    });
    const r = await processEvent(fresh, "e1", { policy, nowMs: NOW });
    expect(r.status).toBe("NO_INCUMBENT");
    const proposals = await fresh.execute(`SELECT count(*) n FROM proposals`);
    expect(proposals.rows[0]!.n).toBe(0);
  });
});
