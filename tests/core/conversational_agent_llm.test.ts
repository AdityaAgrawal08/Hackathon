import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import {
  processInboundCustomerMessage,
  classifyConversationalIntent,
  detectHinglish,
  callGroqAgentLoop,
} from "../../packages/core/src/agent/conversational_agent.js";
import { AGENT_TOOL_DEFINITIONS } from "../../packages/core/src/agent/agent_tools.js";

const TEST_DB_URL = ":memory:";

describe("FIX-020: Conversational Agent LLM Loop & Hinglish Reasoning", () => {
  let client: Client;

  beforeAll(async () => {
    client = createClient({ url: TEST_DB_URL });
    await runMigrations(client);

    const nowUtc = new Date().toISOString();
    await client.execute({
      sql: `INSERT OR REPLACE INTO customer_profiles (id, phone, email, name, opted_out, created_at_utc)
            VALUES ('prof_llm_test_01', '+919876543210', 'llm_test@example.com', 'Hinglish Tester', 0, ?)`,
      args: [nowUtc],
    });

    await client.execute({
      sql: `INSERT OR REPLACE INTO live_payment_events
            (id, razorpay_payment_id, customer_profile_id, product_name, amount_paise, status, failure_code, failure_description, created_at_utc)
            VALUES ('evt_llm_test_01', 'pay_llm_test_01', 'prof_llm_test_01', 'Enterprise Cloud Retainer', 999900, 'failed', 'BAD_REQUEST_PAYMENT_TIMED_OUT', 'Bank network timeout', ?)`,
      args: [nowUtc],
    });
  });

  describe("Hinglish Detection & Intent Classification", () => {
    it("detects Hinglish phrases with high precision", () => {
      expect(detectHinglish("paisa kat gaya mere bank account se")).toBe(true);
      expect(detectHinglish("kal salary aayegi tab dunga")).toBe(true);
      expect(detectHinglish("kuch discount milega kya please")).toBe(true);
      expect(detectHinglish("nahi chahiye mujhe yeh service, band karo")).toBe(true);
      expect(detectHinglish("Please send me the UPI QR code to complete payment")).toBe(false);
      expect(detectHinglish("Why did my transaction fail?")).toBe(false);
    });

    it("classifies Hinglish intent into structured recovery actions", () => {
      // Reschedule
      expect(classifyConversationalIntent("kal salary aane ke baad pay karunga").intent).toBe("RESCHEDULE_REQUEST");
      expect(classifyConversationalIntent("parso payment kar dunga pakka").intent).toBe("RESCHEDULE_REQUEST");
      expect(classifyConversationalIntent("Can you remind me tomorrow at 10 AM?").intent).toBe("RESCHEDULE_REQUEST");

      // Failure inquiry
      expect(classifyConversationalIntent("paisa kat gaya lekin order confirm nahi hua").intent).toBe("FAILURE_INQUIRY");
      expect(classifyConversationalIntent("account se balance cut ho gaya hai").intent).toBe("FAILURE_INQUIRY");
      expect(classifyConversationalIntent("Why did my card payment fail?").intent).toBe("FAILURE_INQUIRY");

      // Price objection
      expect(classifyConversationalIntent("bahut mehenga hai, thoda discount dedo").intent).toBe("PRICE_OBJECTION");
      expect(classifyConversationalIntent("kam karo price, discount milega?").intent).toBe("PRICE_OBJECTION");
      expect(classifyConversationalIntent("Too expensive, can I get a 10% coupon?").intent).toBe("PRICE_OBJECTION");

      // Compliance / Opt-out
      expect(classifyConversationalIntent("band karo messages mat bhejo").intent).toBe("OPT_OUT");
      expect(classifyConversationalIntent("STOP unsubscribe me now").intent).toBe("OPT_OUT");

      // Human escalation / dispute
      expect(classifyConversationalIntent("kisi human support se baat karao").intent).toBe("HUMAN_DISPUTE");
      expect(classifyConversationalIntent("I need to speak with a human agent").intent).toBe("HUMAN_DISPUTE");
    });
  });

  describe("Agent Tool Definitions & Schema Compliance", () => {
    it("exposes all required tools with valid OpenAI/Groq function calling schema", () => {
      const toolNames = AGENT_TOOL_DEFINITIONS.map((t) => t.function.name);
      expect(toolNames).toContain("check_issuer_rail_health");
      expect(toolNames).toContain("evaluate_margin_discount");
      expect(toolNames).toContain("generate_1tap_upi_deep_link");
      expect(toolNames).toContain("schedule_trai_compliant_touch");
      expect(toolNames).toContain("escalate_to_human_support");

      for (const def of AGENT_TOOL_DEFINITIONS) {
        expect(def.type).toBe("function");
        expect(def.function.name).toBeDefined();
        expect(def.function.description).toBeDefined();
        expect(def.function.parameters).toBeDefined();
        expect(def.function.parameters.type).toBe("object");
        expect(def.function.parameters.properties).toBeDefined();
      }
    });
  });

  describe("callGroqAgentLoop Resilience & Fallback", () => {
    it("falls back gracefully when Groq API key is not configured or in sandbox", async () => {
      const result = await callGroqAgentLoop(
        "prof_llm_test_01",
        "evt_llm_test_01",
        "paisa kat gaya mera",
        client,
        1772670000000,
      );

      if (!process.env.GROQ_API_KEY) {
        expect(result).toBeNull();
      }
    });
  });

  describe("End-to-End Inbound Message Processing", () => {
    it("processes Hinglish reschedule request and records audit ledger", async () => {
      const resp = await processInboundCustomerMessage(
        {
          from: "+919876543210",
          text: "kal payment karunga salary aane ke baad",
          channel: "SMS",
          nowMs: 1772670000000,
        },
        client,
      );

      expect(resp.intent).toBe("RESCHEDULE_REQUEST");
      expect(resp.replyText).toBeDefined();
      expect(resp.auditEntryId).toBeDefined();
      expect(resp.toolCalls.length).toBeGreaterThanOrEqual(1);
      expect(resp.toolCalls[0].toolName).toBe("schedule_trai_compliant_touch");
    });

    it("processes Hinglish failure inquiry with conversational reassurance", async () => {
      const resp = await processInboundCustomerMessage(
        {
          from: "+919876543210",
          text: "paisa cut ho gaya par product activate nahi hua",
          channel: "SMS",
          nowMs: 1772670000000,
        },
        client,
      );

      expect(resp.intent).toBe("FAILURE_INQUIRY");
      expect(resp.replyText).toBeDefined();
      expect(resp.recoveryUrl).toBeDefined();
      expect(resp.auditEntryId).toBeDefined();
    });

    it("processes human support escalation and creates support escalation ticket", async () => {
      const resp = await processInboundCustomerMessage(
        {
          from: "+919876543210",
          text: "kisi human agent se baat karwao turant",
          channel: "SMS",
          nowMs: 1772670000000,
        },
        client,
      );

      expect(resp.intent).toBe("HUMAN_DISPUTE");
      expect(resp.replyText).toContain("specialist");

      // Verify ticket inserted into support_escalation_tickets (FIX-016)
      const tickets = await client.execute({
        sql: `SELECT * FROM support_escalation_tickets WHERE customer_id = 'prof_llm_test_01' ORDER BY created_at_utc DESC`,
        args: [],
      });
      expect(tickets.rows.length).toBeGreaterThan(0);
      expect(String(tickets.rows[0].status).toLowerCase()).toBe("open");
    });
  });
});
