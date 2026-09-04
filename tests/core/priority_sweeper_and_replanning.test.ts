import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import {
  openDb,
  applyDbPragmas,
  runMigrations,
  sequenceIntelligentRecoveryBatch,
  isWithinTRAIQuietHours,
} from "../../packages/core/src/index.js";
import { app, dbClient, sweepScheduledOutreach } from "../../app/server.js";

describe("Phase 4: Dynamic Priority Queue Sweeper Daemon & Active Re-Planning", () => {
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

  describe("1. Intelligent Sweeper Daemon & EV Prioritization", () => {
    it("prioritizes high-EV fast openers over low-EV slow openers during active business hours", async () => {
      const client = createClient({ url: ":memory:" });
      await applyDbPragmas(client);
      await runMigrations(client);

      // Daytime: 14:00 IST = 08:30 UTC
      const activeMs = new Date("2026-09-02T08:30:00.000Z").getTime();
      const activeUtc = new Date(activeMs).toISOString();

      // Customer A: High ticket ₹10,000, fast opener (10 min open latency)
      await client.execute({
        sql: `INSERT INTO customer_profiles
              (id, name, phone, email, email_open_latency_mins, total_attempts, created_at_utc)
              VALUES ('cust_high_ev', 'Fast High EV', '+919876543201', 'fasthigh@test.com', 10, 0, ?)`,
        args: [activeUtc],
      });
      await client.execute({
        sql: `INSERT INTO live_payment_events
              (id, customer_profile_id, product_name, amount_paise, status, ml_probability, created_at_utc)
              VALUES ('evt_high', 'cust_high_ev', 'Enterprise Plan', 1000000, 'failed', 0.8, ?)`,
        args: [activeUtc],
      });
      await client.execute({
        sql: `INSERT INTO scheduled_outreach
              (id, live_payment_event_id, customer_profile_id, channel, scheduled_at_utc, executed)
              VALUES ('so_high', 'evt_high', 'cust_high_ev', 'EMAIL', ?, 0)`,
        args: [activeUtc],
      });

      // Customer B: Low ticket ₹1,000, slow opener (300 min open latency)
      await client.execute({
        sql: `INSERT INTO customer_profiles
              (id, name, phone, email, email_open_latency_mins, total_attempts, created_at_utc)
              VALUES ('cust_low_ev', 'Slow Low EV', '+919876543202', 'slowlow@test.com', 300, 0, ?)`,
        args: [activeUtc],
      });
      await client.execute({
        sql: `INSERT INTO live_payment_events
              (id, customer_profile_id, product_name, amount_paise, status, ml_probability, created_at_utc)
              VALUES ('evt_low', 'cust_low_ev', 'Basic Plan', 100000, 'failed', 0.4, ?)`,
        args: [activeUtc],
      });
      await client.execute({
        sql: `INSERT INTO scheduled_outreach
              (id, live_payment_event_id, customer_profile_id, channel, scheduled_at_utc, executed)
              VALUES ('so_low', 'evt_low', 'cust_low_ev', 'EMAIL', ?, 0)`,
        args: [activeUtc],
      });

      const result = await sweepScheduledOutreach(activeMs, client);

      expect(result.sweptCount).toBe(2);
      expect(result.dispatchedCount).toBe(2);
      expect(result.suppressedCount).toBe(0);
      expect(result.deferredCount).toBe(0);

      // Verify sequence order: high EV candidate is first
      expect(result.sequenced?.candidates[0].id).toBe("so_high");
      expect(result.sequenced?.candidates[1].id).toBe("so_low");
      expect(result.sequenced?.candidates[0].priorityScore).toBeGreaterThan(
        result.sequenced?.candidates[1].priorityScore!,
      );

      // Verify DB marked executed
      const updated = await client.execute("SELECT id, executed, status FROM scheduled_outreach");
      expect(updated.rows.every((r: any) => r.executed === 1 && r.status === "SENT")).toBe(true);
    });

    it("defers outreach past TRAI quiet hours (21:00-09:00 IST) to 09:00:01 IST next morning", async () => {
      const client = createClient({ url: ":memory:" });
      await applyDbPragmas(client);
      await runMigrations(client);

      // Quiet hours: 22:30 IST = 17:00 UTC
      const quietMs = new Date("2026-09-02T17:00:00.000Z").getTime();
      const quietUtc = new Date(quietMs).toISOString();

      await client.execute({
        sql: `INSERT INTO customer_profiles
              (id, name, phone, email, total_attempts, created_at_utc)
              VALUES ('cust_quiet', 'Night Shopper', '+919876543203', 'night@test.com', 0, ?)`,
        args: [quietUtc],
      });
      await client.execute({
        sql: `INSERT INTO live_payment_events
              (id, customer_profile_id, product_name, amount_paise, status, created_at_utc)
              VALUES ('evt_quiet', 'cust_quiet', 'Premium Annual', 499900, 'failed', ?)`,
        args: [quietUtc],
      });
      await client.execute({
        sql: `INSERT INTO scheduled_outreach
              (id, live_payment_event_id, customer_profile_id, channel, scheduled_at_utc, executed)
              VALUES ('so_quiet', 'evt_quiet', 'cust_quiet', 'SMS', ?, 0)`,
        args: [quietUtc],
      });

      const result = await sweepScheduledOutreach(quietMs, client);

      expect(result.sweptCount).toBe(1);
      expect(result.dispatchedCount).toBe(0);
      expect(result.deferredCount).toBe(1);

      // Verify row is NOT marked executed, but scheduled_at_utc is deferred to next day 09:00:01 IST
      const check = await client.execute("SELECT executed, status, scheduled_at_utc FROM scheduled_outreach WHERE id = 'so_quiet'");
      expect(check.rows[0].executed).toBe(0);

      const deferredDate = new Date(String(check.rows[0].scheduled_at_utc));
      const istOffsetMs = 5.5 * 60 * 60 * 1000;
      const deferredIst = new Date(deferredDate.getTime() + istOffsetMs);
      expect(deferredIst.getUTCHours()).toBe(9);
      expect(deferredIst.getUTCMinutes()).toBe(0);
    });

    it("suppresses outreach permanently for opted-out or max-attempted customers", async () => {
      const client = createClient({ url: ":memory:" });
      await applyDbPragmas(client);
      await runMigrations(client);

      const activeMs = new Date("2026-09-02T08:30:00.000Z").getTime();
      const activeUtc = new Date(activeMs).toISOString();

      // Customer Opted Out
      await client.execute({
        sql: `INSERT INTO customer_profiles
              (id, name, phone, email, opted_out, total_attempts, created_at_utc)
              VALUES ('cust_optout', 'Opt Out Cust', '+919876543204', 'optout@test.com', 1, 0, ?)`,
        args: [activeUtc],
      });
      await client.execute({
        sql: `INSERT INTO live_payment_events
              (id, customer_profile_id, product_name, amount_paise, status, created_at_utc)
              VALUES ('evt_optout', 'cust_optout', 'Basic', 99900, 'failed', ?)`,
        args: [activeUtc],
      });
      await client.execute({
        sql: `INSERT INTO scheduled_outreach
              (id, live_payment_event_id, customer_profile_id, channel, scheduled_at_utc, executed)
              VALUES ('so_optout', 'evt_optout', 'cust_optout', 'SMS', ?, 0)`,
        args: [activeUtc],
      });

      // Customer Max Attempts Exceeded
      await client.execute({
        sql: `INSERT INTO customer_profiles
              (id, name, phone, email, opted_out, total_attempts, created_at_utc)
              VALUES ('cust_maxatt', 'Max Attempts Cust', '+919876543205', 'max@test.com', 0, 3, ?)`,
        args: [activeUtc],
      });
      await client.execute({
        sql: `INSERT INTO live_payment_events
              (id, customer_profile_id, product_name, amount_paise, status, created_at_utc)
              VALUES ('evt_maxatt', 'cust_maxatt', 'Basic', 99900, 'failed', ?)`,
        args: [activeUtc],
      });
      await client.execute({
        sql: `INSERT INTO scheduled_outreach
              (id, live_payment_event_id, customer_profile_id, channel, scheduled_at_utc, executed)
              VALUES ('so_maxatt', 'evt_maxatt', 'cust_maxatt', 'EMAIL', ?, 0)`,
        args: [activeUtc],
      });

      const result = await sweepScheduledOutreach(activeMs, client);

      expect(result.sweptCount).toBe(2);
      expect(result.dispatchedCount).toBe(0);
      expect(result.suppressedCount).toBe(2);

      const rows = await client.execute("SELECT id, executed, status, error_message FROM scheduled_outreach");
      for (const r of rows.rows as any[]) {
        expect(r.executed).toBe(1);
        expect(r.status).toBe("SUPPRESSED");
        expect(["CUSTOMER_OPT_OUT", "MAX_ATTEMPTS_EXCEEDED"]).toContain(r.error_message);
      }
    });
  });

  describe("2. Customer Portal Interaction Beacons & Dynamic Re-Planning", () => {
    it("handles PORTAL_OPENED telemetry beacon cleanly", async () => {
      const now = new Date().toISOString();
      const eventId = `evt_beacon_open_${Date.now()}`;

      await dbClient.execute({
        sql: `INSERT OR REPLACE INTO customer_profiles (id, name, phone, email, created_at_utc)
              VALUES ('cust_b1', 'Beacon Tester', '+919999911111', 'beacon@test.com', ?)`,
        args: [now],
      });
      await dbClient.execute({
        sql: `INSERT INTO live_payment_events (id, customer_profile_id, product_name, amount_paise, status, created_at_utc)
              VALUES (?, 'cust_b1', 'Premium Plan', 499900, 'failed', ?)`,
        args: [eventId, now],
      });

      const res = await fetch(`${baseUrl}/api/events/${eventId}/interaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          interactionType: "PORTAL_OPENED",
          dwellTimeSeconds: 0,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.rePlanResult.action).toBe("NO_ACTION");
    });

    it("triggers 3-installment split-pay downsell when dwell time >= 20s and customer drops off", async () => {
      const now = new Date().toISOString();
      const eventId = `evt_beacon_split_${Date.now()}`;

      await dbClient.execute({
        sql: `INSERT OR REPLACE INTO customer_profiles (id, name, phone, email, created_at_utc)
              VALUES ('cust_b2', 'Sticker Shock Cust', '+919999922222', 'shock@test.com', ?)`,
        args: [now],
      });
      await dbClient.execute({
        sql: `INSERT INTO live_payment_events (id, customer_profile_id, product_name, amount_paise, status, created_at_utc)
              VALUES (?, 'cust_b2', 'High Ticket Course', 299900, 'failed', ?)`,
        args: [eventId, now],
      });

      const res = await fetch(`${baseUrl}/api/events/${eventId}/interaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          interactionType: "PORTAL_EXITED_NO_PAY",
          dwellTimeSeconds: 25,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.rePlanResult.action).toBe("TRIGGER_DOWNSELL_SPLIT");
      expect(data.rePlanResult.concessionType).toBe("SPLIT_PAY");
      expect(data.rePlanResult.concessionPaise).toBe(Math.round(299900 / 3));

      // Verify audit ledger entry was written
      const audit = await dbClient.execute({
        sql: "SELECT * FROM audit_ledger WHERE entity_id = ? AND event_type = 'RE_PLANNED' ORDER BY created_at_utc DESC LIMIT 1",
        args: [eventId],
      });
      expect(audit.rows.length).toBe(1);
    });

    it("dynamically recommends SWITCH_TO_1TAP_UPI when secondary card attempt fails in portal", async () => {
      const now = new Date().toISOString();
      const eventId = `evt_beacon_upi_${Date.now()}`;

      await dbClient.execute({
        sql: `INSERT OR REPLACE INTO customer_profiles (id, name, phone, email, created_at_utc)
              VALUES ('cust_b3', 'Declined Card Cust', '+919999933333', 'declined@test.com', ?)`,
        args: [now],
      });
      await dbClient.execute({
        sql: `INSERT INTO live_payment_events (id, customer_profile_id, product_name, amount_paise, status, created_at_utc)
              VALUES (?, 'cust_b3', 'Premium Subscription', 499900, 'failed', ?)`,
        args: [eventId, now],
      });

      const res = await fetch(`${baseUrl}/api/events/${eventId}/interaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          interactionType: "PAYMENT_ATTEMPTED_FAILED",
          dwellTimeSeconds: 30,
          failedPaymentMethod: "card",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.rePlanResult.action).toBe("SWITCH_TO_1TAP_UPI");
    });
  });
});
