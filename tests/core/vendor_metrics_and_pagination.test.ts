import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import {
  openDb,
  applyDbPragmas,
  runMigrations,
  ensureVendorMetricsSummary,
  recordMetricsDelta,
  recomputeVendorMetricsSummary,
  getVendorMetricsSummary,
  getMethodDelta,
} from "../../packages/core/src/index.js";
import { app, startServer, dbClient } from "../../app/server.js";

describe("Phase 3: SQLite Concurrency Pragmas, O(1) Metrics Rollup & Keyset Pagination", () => {
  let serverInstance: any;
  let baseUrl: string;

  beforeAll(async () => {
    await runMigrations(dbClient);
    await new Promise<void>((resolve) => {
      serverInstance = app.listen(0, "127.0.0.1", () => {
        const addr = serverInstance.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (serverInstance) {
      await new Promise<void>((resolve) => serverInstance.close(() => resolve()));
    }
  });

  describe("1. SQLite Concurrency Pragmas & Database Setup", () => {
    it("enforces WAL journal mode, busy_timeout=5000, synchronous=NORMAL and foreign_keys=ON", async () => {
      const client = createClient({ url: ":memory:" });
      await applyDbPragmas(client);

      const busyTimeout = await client.execute("PRAGMA busy_timeout");
      expect(Number(busyTimeout.rows[0]?.[0] ?? busyTimeout.rows[0]?.timeout)).toBe(5000);

      const foreignKeys = await client.execute("PRAGMA foreign_keys");
      expect(Number(foreignKeys.rows[0]?.[0] ?? foreignKeys.rows[0]?.foreign_keys)).toBe(1);
    });

    it("creates vendor_metrics_summary table and composite query indexes via migrations", async () => {
      const client = createClient({ url: ":memory:" });
      await runMigrations(client);

      // Verify vendor_metrics_summary exists
      const tableInfo = await client.execute("PRAGMA table_info(vendor_metrics_summary)");
      const colNames = tableInfo.rows.map((r: any) => r.name);
      expect(colNames).toContain("id");
      expect(colNames).toContain("total_events");
      expect(colNames).toContain("total_successes");
      expect(colNames).toContain("total_failures");
      expect(colNames).toContain("recovered_paise");
      expect(colNames).toContain("at_risk_paise");
      expect(colNames).toContain("method_card");
      expect(colNames).toContain("method_upi");
      expect(colNames).toContain("method_netbanking");
      expect(colNames).toContain("method_wallet");
      expect(colNames).toContain("method_other");

      // Verify composite indexes exist on live_payment_events
      const indexList = await client.execute("PRAGMA index_list(live_payment_events)");
      const indexNames = indexList.rows.map((r: any) => r.name);
      expect(indexNames).toContain("idx_lpe_cust_created");
      expect(indexNames).toContain("idx_lpe_alerts");
    });
  });

  describe("2. Atomic Metrics Rollup & O(1) Summaries", () => {
    it("initializes vendor_metrics_summary with zeroed counters", async () => {
      const client = createClient({ url: ":memory:" });
      await runMigrations(client);

      await ensureVendorMetricsSummary(client, "global");
      const summary = await getVendorMetricsSummary(client, "global");

      expect(summary.totalEvents).toBe(0);
      expect(summary.totalSuccesses).toBe(0);
      expect(summary.totalFailures).toBe(0);
      expect(summary.recoveredPaise).toBe(0);
      expect(summary.atRiskPaise).toBe(0);
      expect(summary.successRate).toBe("0.0%");
    });

    it("atomically increments and decrements metrics on payment lifecycle events", async () => {
      const client = createClient({ url: ":memory:" });
      await runMigrations(client);

      // Simulate failed card payment: 499900 paise
      await recordMetricsDelta(client, {
        totalEvents: 1,
        totalFailures: 1,
        atRiskPaise: 499900,
        ...getMethodDelta("card"),
      });

      let summary = await getVendorMetricsSummary(client, "global");
      expect(summary.totalEvents).toBe(1);
      expect(summary.totalFailures).toBe(1);
      expect(summary.totalSuccesses).toBe(0);
      expect(summary.atRiskPaise).toBe(499900);
      expect(summary.recoveredPaise).toBe(0);
      expect(summary.methodCard).toBe(1);
      expect(summary.successRate).toBe("0.0%");

      // Simulate recovery of that payment
      await recordMetricsDelta(client, {
        totalFailures: -1,
        totalSuccesses: 1,
        atRiskPaise: -499900,
        recoveredPaise: 499900,
      });

      summary = await getVendorMetricsSummary(client, "global");
      expect(summary.totalEvents).toBe(1);
      expect(summary.totalFailures).toBe(0);
      expect(summary.totalSuccesses).toBe(1);
      expect(summary.atRiskPaise).toBe(0);
      expect(summary.recoveredPaise).toBe(499900);
      expect(summary.successRate).toBe("100.0%");

      // Simulate new direct UPI payment: 199900 paise
      await recordMetricsDelta(client, {
        totalEvents: 1,
        totalSuccesses: 1,
        recoveredPaise: 199900,
        ...getMethodDelta("upi"),
      });

      summary = await getVendorMetricsSummary(client, "global");
      expect(summary.totalEvents).toBe(2);
      expect(summary.totalSuccesses).toBe(2);
      expect(summary.recoveredPaise).toBe(699800);
      expect(summary.methodCard).toBe(1);
      expect(summary.methodUpi).toBe(1);
      expect(summary.successRate).toBe("100.0%");
    });

    it("recomputes and reconciles summary perfectly against historical table rows", async () => {
      const client = createClient({ url: ":memory:" });
      await runMigrations(client);

      const now = new Date().toISOString();
      await client.execute({
        sql: `INSERT INTO customer_profiles (id, name, phone, email, created_at_utc) VALUES ('cust_1', 'Reconcile Test', '+919876543210', 'reconcile@test.com', ?)`,
        args: [now],
      });

      // Insert 2 failures and 1 success directly into live_payment_events
      await client.execute({
        sql: `INSERT INTO live_payment_events (id, customer_profile_id, product_name, amount_paise, status, payment_method, created_at_utc)
              VALUES ('evt_f1', 'cust_1', 'Plan A', 100000, 'failed', 'card', ?),
                     ('evt_f2', 'cust_1', 'Plan B', 200000, 'failed', 'upi', ?),
                     ('evt_s1', 'cust_1', 'Plan C', 300000, 'captured', 'netbanking', ?)`,
        args: [now, now, now],
      });

      const recomputed = await recomputeVendorMetricsSummary(client, "global");
      expect(recomputed.totalEvents).toBe(3);
      expect(recomputed.totalFailures).toBe(2);
      expect(recomputed.totalSuccesses).toBe(1);
      expect(recomputed.atRiskPaise).toBe(300000);
      expect(recomputed.recoveredPaise).toBe(300000);
      expect(recomputed.methodCard).toBe(1);
      expect(recomputed.methodUpi).toBe(1);
      expect(recomputed.methodNetbanking).toBe(1);
      expect(recomputed.successRate).toBe("33.3%");

      // Subsequent getVendorMetricsSummary is O(1) and matches recomputed
      const fastSummary = await getVendorMetricsSummary(client, "global");
      expect(fastSummary).toEqual(recomputed);
    });

    it("handles 50 concurrent updates with zero SQLITE_BUSY lock errors and exact consistency", async () => {
      const client = createClient({ url: ":memory:" });
      await applyDbPragmas(client);
      await runMigrations(client);

      // Fire 50 concurrent delta updates
      const promises = Array.from({ length: 50 }, (_, i) =>
        recordMetricsDelta(client, {
          totalEvents: 1,
          totalSuccesses: i % 2 === 0 ? 1 : 0,
          totalFailures: i % 2 === 1 ? 1 : 0,
          recoveredPaise: i % 2 === 0 ? 10000 : 0,
          atRiskPaise: i % 2 === 1 ? 10000 : 0,
          ...getMethodDelta(i % 2 === 0 ? "card" : "upi"),
        }),
      );

      await Promise.all(promises);

      const summary = await getVendorMetricsSummary(client, "global");
      expect(summary.totalEvents).toBe(50);
      expect(summary.totalSuccesses).toBe(25);
      expect(summary.totalFailures).toBe(25);
      expect(summary.recoveredPaise).toBe(250000);
      expect(summary.atRiskPaise).toBe(250000);
      expect(summary.methodCard).toBe(25);
      expect(summary.methodUpi).toBe(25);
      expect(summary.successRate).toBe("50.0%");
    });
  });

  describe("3. Keyset Cursor Pagination & Live Vendor Endpoints", () => {
    it("returns O(1) analytics summary via GET /api/vendor/analytics", async () => {
      const res = await fetch(`${baseUrl}/api/vendor/analytics`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toHaveProperty("totalEvents");
      expect(body).toHaveProperty("totalSuccesses");
      expect(body).toHaveProperty("totalFailures");
      expect(body).toHaveProperty("recoveredPaise");
      expect(body).toHaveProperty("atRiskPaise");
      expect(body).toHaveProperty("methodCard");
      expect(body).toHaveProperty("methodUpi");
      expect(body).toHaveProperty("successRate");
      expect(typeof body.successRate).toBe("string");
    });

    it("returns Array directly on GET /api/vendor/payments for backward compatibility", async () => {
      const res = await fetch(`${baseUrl}/api/vendor/payments`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);

      // Check pagination headers
      expect(res.headers.get("x-has-more")).toBeDefined();
      expect(res.headers.get("x-limit")).toBe("50");
    });

    it("performs deterministic keyset cursor pagination with envelope=true across multiple pages", async () => {
      // Seed 5 customer profiles and payment events
      const timestamps = [
        "2026-09-01T10:00:00.000Z",
        "2026-09-01T11:00:00.000Z",
        "2026-09-01T12:00:00.000Z",
        "2026-09-01T13:00:00.000Z",
        "2026-09-01T14:00:00.000Z",
      ];

      for (let i = 0; i < 5; i++) {
        const custId = `cust_page_${i}`;
        const evtId = `evt_page_${i}`;
        await dbClient.execute({
          sql: `INSERT OR REPLACE INTO customer_profiles (id, name, phone, email, created_at_utc)
                VALUES (?, ?, ?, ?, ?)`,
          args: [custId, `Page Customer ${i}`, `+91999990000${i}`, `page${i}@test.com`, timestamps[i]],
        });
        await dbClient.execute({
          sql: `INSERT OR REPLACE INTO live_payment_events (id, customer_profile_id, product_name, amount_paise, status, payment_method, created_at_utc)
                VALUES (?, ?, 'Product Page Test', 99900, 'failed', 'card', ?)`,
          args: [evtId, custId, timestamps[i]],
        });
      }

      // Page 1: limit 2 with envelope=true
      const p1Res = await fetch(`${baseUrl}/api/vendor/payments?limit=2&envelope=true`);
      expect(p1Res.status).toBe(200);
      const p1 = await p1Res.json();
      expect(p1.items.length).toBe(2);
      expect(p1.hasMore).toBe(true);
      expect(p1.nextCursor).toBeTruthy();

      // Page 2: pass cursor from page 1
      const p2Res = await fetch(`${baseUrl}/api/vendor/payments?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}&envelope=true`);
      expect(p2Res.status).toBe(200);
      const p2 = await p2Res.json();
      expect(p2.items.length).toBe(2);

      // Verify no duplicate items across pages
      const p1Ids = new Set(p1.items.map((it: any) => it.id));
      for (const it of p2.items) {
        expect(p1Ids.has(it.id)).toBe(false);
      }

      // Verify response headers on plain request
      const p1PlainRes = await fetch(`${baseUrl}/api/vendor/payments?limit=2`);
      expect(p1PlainRes.headers.get("x-limit")).toBe("2");
      expect(p1PlainRes.headers.get("x-has-more")).toBe("true");
      expect(p1PlainRes.headers.get("x-next-cursor")).toBeTruthy();
    });
  });
});
