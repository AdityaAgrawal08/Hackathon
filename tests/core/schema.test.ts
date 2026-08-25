/**
 * T3 validation gate: schema round-trips + invariant enforcement at the DB layer.
 * Runs against :memory: so it is hermetic.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";

let client: Client;
const NOW = "2026-08-25T12:00:00.000Z";

async function insertBaseGraph() {
  await client.execute({
    sql: `INSERT INTO tenants (id,name,created_at_utc) VALUES ('demo','Demo Merchant',?)`,
    args: [NOW],
  });
  await client.execute({
    sql: `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,joined_at_utc)
          VALUES ('cust_1','demo','Asha K','+919000000001','asha@example.test',?)`,
    args: [NOW],
  });
}

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await runMigrations(client);
});

describe("schema v2 round-trip (T3 gate)", () => {
  it("tenant + customer insert/query", async () => {
    await insertBaseGraph();
    const r = await client.execute(`SELECT pseudo_name FROM customers WHERE id='cust_1'`);
    expect(r.rows[0]?.pseudo_name).toBe("Asha K");
  });

  it("event requires existing customer (FK on)", async () => {
    await expect(
      client.execute({
        sql: `INSERT INTO payment_events (id,tenant_id,customer_id,amount_paise,failure_code,source,occurred_at_utc,ingested_at_utc)
              VALUES ('evt_x','demo','nope',49900,'INSUFFICIENT_FUNDS','SEED',?,?)`,
        args: [NOW, NOW],
      }),
    ).rejects.toThrow();
  });

  it("model_version → proposal → approval → action chain", async () => {
    await client.execute({
      sql: `INSERT INTO payment_events (id,tenant_id,customer_id,amount_paise,failure_code,source,occurred_at_utc,ingested_at_utc)
            VALUES ('evt_1','demo','cust_1',49900,'INSUFFICIENT_FUNDS','SEED',?,?)`,
      args: [NOW, NOW],
    });
    await client.execute({
      sql: `INSERT INTO model_versions (id,weights_json,weights_sha256,dataset_sha256,feature_names_json,metrics_json,trained_at_utc,status)
            VALUES ('logreg@0.1.0','{}','abc','def','[]','{}',?,'INCUMBENT')`,
      args: [NOW],
    });
    await client.execute({
      sql: `INSERT INTO proposals (id,event_id,customer_id,model_version_id,policy_version,action_json,ev_paise,confidence,state,dedupe_key,created_at_utc,updated_at_utc)
            VALUES ('prp_1','evt_1','cust_1','logreg@0.1.0','v1','{"type":"RETRY_PAYDAY"}',40700,0.82,'AWAITING_APPROVAL','k1',?,?)`,
      args: [NOW, NOW],
    });
    await client.execute({
      sql: `INSERT INTO approval_records (id,proposal_id,actor,decision,decided_at_utc)
            VALUES ('apr_1','prp_1','merchant@demo','APPROVE',?)`,
      args: [NOW],
    });
    await client.execute({
      sql: `INSERT INTO actions (id,proposal_id,idempotency_key,executor,payload_json,outcome,executed_at_utc)
            VALUES ('act_1','prp_1','idem-1','sequenced_retry','{}','SUCCEEDED',?)`,
      args: [NOW],
    });
    const r = await client.execute(`SELECT outcome FROM actions WHERE id='act_1'`);
    expect(r.rows[0]?.outcome).toBe("SUCCEEDED");
  });

  it("duplicate webhook event id rejected by dedupe PK (P1-B8)", async () => {
    await client.execute({
      sql: `INSERT INTO webhook_dedupe (provider_event_id,first_seen_utc) VALUES ('evt-wh-1',?)`,
      args: [NOW],
    });
    await expect(
      client.execute({
        sql: `INSERT INTO webhook_dedupe (provider_event_id,first_seen_utc) VALUES ('evt-wh-1',?)`,
        args: [NOW],
      }),
    ).rejects.toThrow();
  });

  it("partial unique index: one OPEN proposal per customer (P5-B8)", async () => {
    // cust_1 already has prp_1 in AWAITING_APPROVAL — second open proposal must fail
    await client.execute({
      sql: `INSERT INTO payment_events (id,tenant_id,customer_id,amount_paise,failure_code,source,occurred_at_utc,ingested_at_utc)
            VALUES ('evt_2','demo','cust_1',29900,'CARD_EXPIRED','SEED',?,?)`,
      args: [NOW, NOW],
    });
    await expect(
      client.execute({
        sql: `INSERT INTO proposals (id,event_id,customer_id,model_version_id,policy_version,action_json,ev_paise,confidence,state,dedupe_key,created_at_utc,updated_at_utc)
              VALUES ('prp_2','evt_2','cust_1','logreg@0.1.0','v1','{"type":"ALTERNATE_UPI_LINK"}',20000,0.7,'AWAITING_APPROVAL','k2',?,?)`,
        args: [NOW, NOW],
      }),
    ).rejects.toThrow();

    // Terminal state frees the slot
    await client.execute({ sql: `UPDATE proposals SET state='EXECUTED' WHERE id='prp_1'` });
    await client.execute({
      sql: `INSERT INTO proposals (id,event_id,customer_id,model_version_id,policy_version,action_json,ev_paise,confidence,state,dedupe_key,created_at_utc,updated_at_utc)
            VALUES ('prp_3','evt_2','cust_1','logreg@0.1.0','v1','{"type":"ALTERNATE_UPI_LINK"}',20000,0.7,'AWAITING_APPROVAL','k3',?,?)`,
      args: [NOW, NOW],
    });
    const r = await client.execute(
      `SELECT count(*) AS n FROM proposals WHERE customer_id='cust_1' AND state='AWAITING_APPROVAL'`,
    );
    expect(Number(r.rows[0]?.n)).toBe(1);
  });

  it("append-only ledger accepts inserts and rows are addressable", async () => {
    await client.execute({
      sql: `INSERT INTO audit_log (ts_utc,tenant_id,event_id,actor,entry_type,payload_json)
            VALUES (?,'demo','evt_1','POLICY','REFUSAL','{"rule":"quiet_hours"}')`,
      args: [NOW],
    });
    const r = await client.execute(`SELECT entry_type FROM audit_log ORDER BY seq DESC LIMIT 1`);
    expect(r.rows[0]?.entry_type).toBe("REFUSAL");
  });
});
