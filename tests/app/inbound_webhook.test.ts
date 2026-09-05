/**
 * Specialized Test Suite: Two-Way Conversational Recovery & Regulatory Inbound Webhook (FIX-037)
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import {
  classifyConversationalIntent,
  processInboundCustomerMessage,
} from "../../packages/core/src/agent/conversational_agent.js";

const TEST_DB_URL = "file:./data/arbiter_test.sqlite";

describe("FIX-037: Two-Way Conversational Recovery & Inbound Webhooks", () => {
  let client: Client;

  beforeAll(async () => {
    client = createClient({ url: TEST_DB_URL });
    await runMigrations(client);

    // Seed test customer profile and failed payment event
    const nowUtc = new Date().toISOString();
    await client.execute({
      sql: `INSERT OR REPLACE INTO customer_profiles (id, phone, email, name, opted_out, created_at_utc)
            VALUES ('prof_conv_01', '+919999988888', 'conv_user@example.com', 'Conversational User', 0, ?)`,
      args: [nowUtc],
    });

    await client.execute({
      sql: `INSERT OR REPLACE INTO live_payment_events
            (id, razorpay_payment_id, customer_profile_id, product_name, amount_paise, status, failure_code, failure_description, created_at_utc)
            VALUES ('evt_conv_01', 'pay_conv_01', 'prof_conv_01', 'E-Commerce Cart', 250000, 'failed', 'BAD_REQUEST_ERROR', 'Wrong UPI PIN entered', ?)`,
      args: [nowUtc],
    });
  });

  describe("Deterministic Intent Classification", () => {
    it("classifies regulatory compliance opt-out keywords with 1.0 confidence", () => {
      const optOutTexts = ["STOP", "unsubscribe", "Opt Out", "dnd", "Please stop reminders", "do not message me"];
      for (const text of optOutTexts) {
        const result = classifyConversationalIntent(text);
        expect(result.intent).toBe("OPT_OUT");
        expect(result.confidence).toBe(1.0);
      }
    });

    it("classifies price objections and discount negotiations", () => {
      const priceTexts = ["This is too expensive", "Can I get a discount?", "Any coupon available?", "Reduce price please"];
      for (const text of priceTexts) {
        const result = classifyConversationalIntent(text);
        expect(result.intent).toBe("PRICE_OBJECTION");
        expect(result.confidence).toBeGreaterThan(0.8);
      }
    });

    it("classifies reschedule requests and guarantees TRAI quiet-hour compliance (09:00 - 21:00 IST)", () => {
      const rescheduleTexts = ["Pay tomorrow", "Remind me next week", "I will pay on payday when salary arrives", "remind me after 2 days"];
      for (const text of rescheduleTexts) {
        const result = classifyConversationalIntent(text);
        expect(result.intent).toBe("RESCHEDULE_REQUEST");
        expect(result.extractedDateUtc).toBeDefined();

        // Verify the extracted target date is outside TRAI quiet hours (09:00 - 21:00 IST)
        const targetDate = new Date(result.extractedDateUtc!);
        const IST_OFFSET_MS = 5.5 * 3600 * 1000;
        const istHour = new Date(targetDate.getTime() + IST_OFFSET_MS).getUTCHours();
        expect(istHour).toBeGreaterThanOrEqual(9);
        expect(istHour).toBeLessThan(21);
      }
    });

    it("classifies banking failure inquiries", () => {
      const queryTexts = ["Why did my payment fail?", "What is the error?", "Money was deducted but order failed", "Why declined?"];
      for (const text of queryTexts) {
        const result = classifyConversationalIntent(text);
        expect(result.intent).toBe("FAILURE_INQUIRY");
        expect(result.confidence).toBeGreaterThan(0.8);
      }
    });

    it("classifies explicit retry / payment link requests", () => {
      const retryTexts = ["How to pay?", "Send link", "I want to pay now", "Retry payment"];
      for (const text of retryTexts) {
        const result = classifyConversationalIntent(text);
        expect(result.intent).toBe("HELP_RETRY");
      }
    });
  });

  describe("Autonomous Conversational Actions", () => {
    it("handles OPT_OUT: sets customer opted_out = 1 and suppresses pending outreach", async () => {
      // Seed pending scheduled outreach
      await client.execute({
        sql: `INSERT OR REPLACE INTO scheduled_outreach
              (id, live_payment_event_id, customer_profile_id, channel, scheduled_at_utc, executed, status)
              VALUES ('so_conv_opt', 'evt_conv_01', 'prof_conv_01', 'SMS', '2026-03-10T10:00:00.000Z', 0, 'PENDING')`,
        args: [],
      });

      const reply = await processInboundCustomerMessage(client, {
        from: "+919999988888",
        channel: "SMS",
        text: "STOP",
      });

      expect(reply.success).toBe(true);
      expect(reply.intent).toBe("OPT_OUT");
      expect(reply.replyText).toContain("unsubscribed");
      expect(reply.auditEntryId).toBeDefined();

      // Check database state
      const prof = await client.execute({
        sql: `SELECT opted_out FROM customer_profiles WHERE id = 'prof_conv_01'`,
        args: [],
      });
      expect(Number(prof.rows[0].opted_out)).toBe(1);

      const so = await client.execute({
        sql: `SELECT status FROM scheduled_outreach WHERE id = 'so_conv_opt'`,
        args: [],
      });
      expect(String(so.rows[0].status)).toBe("SUPPRESSED");
    });

    it("handles PRICE_OBJECTION: returns bounded 10% courtesy discount recovery URL", async () => {
      const reply = await processInboundCustomerMessage(client, {
        from: "+919999988888",
        channel: "SMS",
        text: "Too expensive, can I get a discount?",
      });

      expect(reply.success).toBe(true);
      expect(reply.intent).toBe("PRICE_OBJECTION");
      expect(reply.discountOfferedPercent).toBe(10);
      expect(reply.recoveryUrl).toContain("discount=10");
      expect(reply.replyText).toContain("10%");
      expect(reply.auditEntryId).toBeDefined();
    });

    it("handles RESCHEDULE_REQUEST: updates schedule in database and returns confirmation", async () => {
      const reply = await processInboundCustomerMessage(client, {
        from: "+919999988888",
        channel: "SMS",
        text: "Pay tomorrow after 12 PM",
      });

      expect(reply.success).toBe(true);
      expect(reply.intent).toBe("RESCHEDULE_REQUEST");
      expect(reply.rescheduledAtUtc).toBeDefined();
      expect(reply.replyText).toContain("rescheduled");
      expect(reply.recoveryUrl).toContain("/recover/evt_conv_01");
    });

    it("handles FAILURE_INQUIRY: explains plain human reason without exposing raw system stack traces", async () => {
      const reply = await processInboundCustomerMessage(client, {
        from: "+919999988888",
        channel: "SMS",
        text: "Why did my transaction fail?",
      });

      expect(reply.success).toBe(true);
      expect(reply.intent).toBe("FAILURE_INQUIRY");
      expect(reply.replyText).toContain("couldn't be processed");
      expect(reply.replyText).toContain("No money was lost");
    });
  });

  describe("API Endpoint POST /api/webhooks/inbound-message", () => {
    it("returns 400 when from or text is missing", async () => {
      const { app } = await import("../../app/server.js");
      const server = app.listen(0);
      const addr = server.address() as any;

      try {
        const res = await fetch(`http://127.0.0.1:${addr.port}/api/webhooks/inbound-message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: "+919999988888" }), // missing text
        });
        expect(res.status).toBe(400);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("processes customer inbound message over HTTP API and returns structured reply", async () => {
      const { app } = await import("../../app/server.js");
      const server = app.listen(0);
      const addr = server.address() as any;

      try {
        const res = await fetch(`http://127.0.0.1:${addr.port}/api/webhooks/inbound-message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "+919999988888",
            text: "Can I get a discount?",
            channel: "SMS",
          }),
        });

        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.success).toBe(true);
        expect(data.intent).toBe("PRICE_OBJECTION");
        expect(data.discountOfferedPercent).toBe(10);
        expect(data.recoveryUrl).toContain("discount=10");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
