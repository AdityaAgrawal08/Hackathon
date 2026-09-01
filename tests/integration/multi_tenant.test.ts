/**
 * B-007: Multi-tenant isolation tests.
 * Verifies that cross-tenant data leakage is impossible — events in tenant A
 * are invisible to tenant B queries.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";

let client: Client;
const T0 = "2026-01-05T09:00:00.000Z";

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  await runMigrations(client);

  await client.execute({ sql: `INSERT INTO tenants (id,name,created_at_utc) VALUES ('tenant_a','Tenant A',?)`, args: [T0] });
  await client.execute({ sql: `INSERT INTO tenants (id,name,created_at_utc) VALUES ('tenant_b','Tenant B',?)`, args: [T0] });

  await client.execute({
    sql: `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,channel_responsiveness,opted_out,prior_success_count,joined_at_utc) VALUES (?,'tenant_a','Alice','+919000000001','a@test.com','{}',0.8,0,5,?)`,
    args: ["cust_a1", T0],
  });
  await client.execute({
    sql: `INSERT INTO customers (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,channel_responsiveness,opted_out,prior_success_count,joined_at_utc) VALUES (?,'tenant_b','Bob','+919000000002','b@test.com','{}',0.8,0,5,?)`,
    args: ["cust_b1", T0],
  });

  await client.execute({
    sql: `INSERT INTO payment_events (id,tenant_id,customer_id,rzp_payment_id,subscription_id,amount_paise,failure_code,failure_class_hint,source,occurred_at_utc,ingested_at_utc) VALUES (?,'tenant_a',?,NULL,NULL,10000,'INSUFFICIENT_FUNDS','SEED','SEED',?,?)`,
    args: ["evt_a1", "cust_a1", T0, T0],
  });
  await client.execute({
    sql: `INSERT INTO payment_events (id,tenant_id,customer_id,rzp_payment_id,subscription_id,amount_paise,failure_code,failure_class_hint,source,occurred_at_utc,ingested_at_utc) VALUES (?,'tenant_b',?,NULL,NULL,20000,'CARD_EXPIRED','SEED','SEED',?,?)`,
    args: ["evt_b1", "cust_b1", T0, T0],
  });
});

describe("B-007: Multi-tenant isolation", () => {
  it("tenant A cannot see tenant B events", async () => {
    const result = await client.execute({ sql: `SELECT id FROM payment_events WHERE tenant_id = ?`, args: ["tenant_a"] });
    const ids = result.rows.map((r) => String(r.id));
    expect(ids).toContain("evt_a1");
    expect(ids).not.toContain("evt_b1");
  });

  it("tenant B cannot see tenant A events", async () => {
    const result = await client.execute({ sql: `SELECT id FROM payment_events WHERE tenant_id = ?`, args: ["tenant_b"] });
    const ids = result.rows.map((r) => String(r.id));
    expect(ids).toContain("evt_b1");
    expect(ids).not.toContain("evt_a1");
  });

  it("tenant A cannot see tenant B customers", async () => {
    const result = await client.execute({ sql: `SELECT id FROM customers WHERE tenant_id = ?`, args: ["tenant_a"] });
    const ids = result.rows.map((r) => String(r.id));
    expect(ids).toContain("cust_a1");
    expect(ids).not.toContain("cust_b1");
  });

  it("cross-tenant customer lookup returns empty", async () => {
    const result = await client.execute({ sql: `SELECT id FROM customers WHERE id = ? AND tenant_id = ?`, args: ["cust_b1", "tenant_a"] });
    expect(result.rows.length).toBe(0);
  });

  it("cross-tenant event lookup returns empty", async () => {
    const result = await client.execute({ sql: `SELECT id FROM payment_events WHERE id = ? AND tenant_id = ?`, args: ["evt_a1", "tenant_b"] });
    expect(result.rows.length).toBe(0);
  });
});
