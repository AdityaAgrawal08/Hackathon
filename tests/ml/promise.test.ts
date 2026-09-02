/**
 * §4.7 Promise-to-pay behavioral loop.
 *  - promise_to_pay table exists after migrations
 *  - recordPromiseToPay / reconcilePromises / queryPromiseKeptRate behave
 *  - the pipeline records a promise when PROMISE_TO_PAY is the chosen action
 *  - promise_kept_rate flows into the feature pipeline (raw)
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { defaultPolicy } from "../../packages/core/src/decide/policy.js";
import { processEvent, editProposal } from "../../packages/ml/src/pipeline.js";
import { saveModel } from "../../packages/ml/src/registry.js";
import { buildArtifact } from "../../packages/ml/src/artifact.js";
import { computeFeatures, FEATURE_NAMES } from "../../packages/ml/src/features.js";
import {
  recordPromiseToPay,
  reconcilePromises,
  markPromiseKept,
  queryPromiseKeptRate,
} from "../../packages/ml/src/promise_store.js";

let client: Client;
const NOW = Date.UTC(2026, 1, 15, 10, 0, 0);
const T0 = "2026-01-05T09:00:00.000Z";

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
  await client.execute({
    sql: `INSERT INTO tenants (id,name,created_at_utc) VALUES ('demo','Demo',?)`,
    args: [T0],
  });
  await client.execute({
    sql: `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,
            channel_responsiveness,opted_out,prior_success_count,joined_at_utc)
          VALUES ('cust_ok','demo','X','+919000000000','x@example.test','{"25":4}',0.7,0,5,?)`,
    args: ["2025-06-01T00:00:00.000Z"],
  });
  await client.execute({
    sql: `INSERT INTO payment_events (id,tenant_id,customer_id,rzp_payment_id,subscription_id,
            amount_paise,failure_code,failure_class_hint,source,true_outcome_seed,occurred_at_utc,ingested_at_utc)
          VALUES ('evt_soft','demo','cust_ok',NULL,NULL,49900,'INSUFFICIENT_FUNDS','SOFT_RETRYABLE','SEED',NULL,?,?)`,
    args: ["2026-02-14T09:00:00.000Z", T0],
  });
});

describe("promise_to_pay table + store", () => {
  it("migrations create promise_to_pay", async () => {
    const r = await client.execute({
      sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='promise_to_pay'`,
    });
    expect(r.rows.length).toBe(1);
  });

  it("records a pending promise and rates 0 resolved", async () => {
    await recordPromiseToPay(client, {
      tenantId: "demo",
      customerId: "cust_ok",
      proposalId: "pA",
      eventId: "evt_soft",
      amountPaise: 49_900,
      nowMs: NOW,
    });
    expect(await queryPromiseKeptRate(client, "cust_ok")).toBe(0);
  });

  it("reconcilePromises closes overdue promises as BROKEN", async () => {
    const closed = await reconcilePromises(client, NOW + 8 * 86_400_000);
    expect(closed).toBe(1);
    expect(await queryPromiseKeptRate(client, "cust_ok")).toBe(0); // kept 0 / broken 1
  });

  it("markPromiseKept lifts the kept-rate", async () => {
    await recordPromiseToPay(client, {
      tenantId: "demo",
      customerId: "cust_ok",
      proposalId: "pB",
      eventId: "evt_soft",
      amountPaise: 49_900,
      nowMs: NOW,
    });
    await markPromiseKept(client, "pB", NOW);
    expect(await queryPromiseKeptRate(client, "cust_ok")).toBeCloseTo(0.5, 5);
  });
});

describe("pipeline records a promise when PROMISE_TO_PAY is chosen", () => {
  it("editProposal redirect to PROMISE_TO_PAY writes a promise row", async () => {
    const permissive = { ...defaultPolicy(), confidence_floor_bp: 0 };
    const r = await processEvent(client, "evt_soft", { nowMs: NOW, policy: permissive });
    expect(r.status).toBe("PROPOSED");
    const edit = await editProposal(client, r.proposalId as string, "PROMISE_TO_PAY", {
      nowMs: NOW,
      policy: permissive,
    });
    expect(edit.ok).toBe(true);
    const rows = await client.execute({
      sql: `SELECT status FROM promise_to_pay WHERE proposal_id = ?`,
      args: [edit.newProposalId as string],
    });
    expect((rows.rows[0] as unknown as { status: string }).status).toBe("PENDING");
  });
});

describe("promise_kept_rate surfaces in features", () => {
  it("flows into computed.raw", () => {
    const computed = computeFeatures({
      failureCode: "INSUFFICIENT_FUNDS",
      amountPaise: 49_900,
      occurredAtUtc: "2026-02-14T09:00:00.000Z",
      priorFailureAmountsPaise: [30_000],
      priorFailureCount: 1,
      customer: {
        paydayPattern: { "25": 4 },
        channelResponsiveness: 0.7,
        priorSuccessCount: 5,
        joinedAtUtc: "2025-06-01T00:00:00.000Z",
        optedOut: false,
        promiseKeptRate: 0.75,
      },
    });
    expect(computed.raw.promiseKeptRate).toBe(0.75);
  });
});
