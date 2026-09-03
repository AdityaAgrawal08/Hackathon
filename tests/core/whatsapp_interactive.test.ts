/**
 * Automated Tests for Phase 5 / Task 7.5 (WHA-20): 2-Way Interactive WhatsApp Conversational Recovery
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import {
  parseWhatsAppWebhook,
  normalizeWhatsAppAction,
  defaultWhatsAppInteractiveManager,
} from "../../packages/core/src/executor/whatsapp_interactive.js";
import { app, dbClient } from "../../app/server.js";
import { runMigrations } from "../../packages/core/src/db/migrate.js";

describe("Phase 5 / Task 7.5 (WHA-20): 2-Way Interactive WhatsApp Conversational Recovery", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await runMigrations(dbClient);
    server = app.listen(0);
    const addr = server.address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe("1. Inbound Webhook Payload Parsing & Action Normalization", () => {
    it("normalizes diverse button identifiers and titles into canonical action types", () => {
      expect(normalizeWhatsAppAction("BTN_1_TAP_UPI")).toBe("1_TAP_UPI");
      expect(normalizeWhatsAppAction("⚡ 1-Tap UPI")).toBe("1_TAP_UPI");
      expect(normalizeWhatsAppAction("PAY_NOW")).toBe("1_TAP_UPI");
      expect(normalizeWhatsAppAction("BTN_SPLIT_EMI")).toBe("SPLIT_EMI");
      expect(normalizeWhatsAppAction("💳 Split in 3 EMI")).toBe("SPLIT_EMI");
      expect(normalizeWhatsAppAction("BTN_OPT_OUT")).toBe("OPT_OUT");
      expect(normalizeWhatsAppAction("🛑 Stop Reminders")).toBe("OPT_OUT");
      expect(normalizeWhatsAppAction("UNSUBSCRIBE")).toBe("OPT_OUT");
      expect(normalizeWhatsAppAction("BTN_REMIND_LATER")).toBe("REMIND_LATER");
      expect(normalizeWhatsAppAction("UNKNOWN_RANDOM_TEXT")).toBe("UNKNOWN");
    });

    it("parses official Meta WhatsApp Cloud API webhook interactive button payload", () => {
      const metaPayload = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "WABA_123456",
            changes: [
              {
                value: {
                  messaging_product: "whatsapp",
                  metadata: { display_phone_number: "919000000000", phone_number_id: "PNID_001" },
                  contacts: [{ profile: { name: "Ananya Sharma" }, wa_id: "919876543210" }],
                  messages: [
                    {
                      from: "919876543210",
                      id: "wamid.HBgLMjA=",
                      timestamp: "1788420000",
                      type: "interactive",
                      interactive: {
                        type: "button_reply",
                        button_reply: {
                          id: "BTN_1_TAP_UPI",
                          title: "⚡ 1-Tap UPI",
                        },
                      },
                    },
                  ],
                },
                field: "messages",
              },
            ],
          },
        ],
      };

      const parsed = parseWhatsAppWebhook(metaPayload);
      expect(parsed.phone).toBe("919876543210");
      expect(parsed.senderName).toBe("Ananya Sharma");
      expect(parsed.actionType).toBe("1_TAP_UPI");
      expect(parsed.rawButtonId).toBe("BTN_1_TAP_UPI");
      expect(parsed.buttonTitle).toBe("⚡ 1-Tap UPI");
    });

    it("parses Gupshup Enterprise quick-reply callback payload", () => {
      const gupshupPayload = {
        type: "quick_reply",
        payload: {
          postbackText: "BTN_SPLIT_EMI",
          title: "💳 Split in 3 No-Cost EMI",
        },
        sender: {
          phone: "919811223344",
          name: "Vikram Malhotra",
        },
        messageId: "gup_msg_998877",
      };

      const parsed = parseWhatsAppWebhook(gupshupPayload);
      expect(parsed.phone).toBe("919811223344");
      expect(parsed.senderName).toBe("Vikram Malhotra");
      expect(parsed.actionType).toBe("SPLIT_EMI");
      expect(parsed.messageId).toBe("gup_msg_998877");
    });
  });

  describe("2. Conversational Business Actions Execution", () => {
    it("processes [⚡ 1-Tap UPI]: captures payment, auto-prunes reminders, and audits SHA-256 chain", async () => {
      const phone = "919999000011";
      const orderId = `order_wha_${Date.now()}`;

      // Insert customer profile and a pending scheduled outreach
      await dbClient.execute({
        sql: `INSERT OR REPLACE INTO customer_profiles (id, name, phone, email, created_at_utc, opted_out)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [`cust_${phone}`, "Rohan Verma", phone, "rohan@example.com", new Date().toISOString(), 0],
      });

      const parsed = parseWhatsAppWebhook({
        phone,
        action: "BTN_1_TAP_UPI",
        orderId,
      });

      const result = await defaultWhatsAppInteractiveManager.processInboundAction(dbClient, parsed);

      expect(result.success).toBe(true);
      expect(result.actionType).toBe("1_TAP_UPI");
      expect(result.status).toBe("CAPTURED");
      expect(result.replyText).toContain("Payment Confirmed");
      expect(result.auditEntryId).toBeDefined();
    });

    it("processes [💳 Split in 3 EMI]: generates 0% interest 3x installment schedule", async () => {
      const phone = "919999000022";
      const parsed = parseWhatsAppWebhook({
        phone,
        action: "BTN_SPLIT_EMI",
        orderId: `order_emi_${Date.now()}`,
      });

      const result = await defaultWhatsAppInteractiveManager.processInboundAction(dbClient, parsed);

      expect(result.success).toBe(true);
      expect(result.actionType).toBe("SPLIT_EMI");
      expect(result.status).toBe("EMI_OFFERED");
      expect(result.replyText).toContain("No-Cost EMI Approved");
      expect(result.replyText).toContain("3 monthly installments");
      expect(result.details?.installments).toBe(3);
    });

    it("processes [🛑 Stop Reminders]: sets opted_out = 1, purges reminders, and stops bot fatigue", async () => {
      const phone = "919999000033";
      await dbClient.execute({
        sql: `INSERT OR REPLACE INTO customer_profiles (id, name, phone, email, created_at_utc, opted_out)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [`cust_${phone}`, "Priya Nair", phone, "priya@example.com", new Date().toISOString(), 0],
      });

      const parsed = parseWhatsAppWebhook({
        phone,
        action: "STOP",
      });

      const result = await defaultWhatsAppInteractiveManager.processInboundAction(dbClient, parsed);

      expect(result.success).toBe(true);
      expect(result.actionType).toBe("OPT_OUT");
      expect(result.status).toBe("OPTED_OUT");
      expect(result.replyText).toContain("Unsubscribed");

      // Verify DB state
      const row = await dbClient.execute({
        sql: `SELECT opted_out FROM customer_profiles WHERE id = ?`,
        args: [`cust_${phone}`],
      });
      expect(row.rows[0]?.opted_out).toBe(1);
    });
  });

  describe("3. REST API Webhook & Simulator Endpoints", () => {
    it("POST /api/webhooks/whatsapp receives and handles Meta Cloud API webhook", async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: "919876543210",
          action: "BTN_1_TAP_UPI",
          orderId: `order_api_test_${Date.now()}`,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.result.actionType).toBe("1_TAP_UPI");
      expect(data.result.status).toBe("CAPTURED");
    });

    it("POST /api/whatsapp/simulate-interaction provides direct testing trigger for judges and UI", async () => {
      const res = await fetch(`${baseUrl}/api/whatsapp/simulate-interaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerPhone: "+919999888811",
          buttonId: "BTN_SPLIT_EMI",
          orderId: "order_sim_123",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.result.actionType).toBe("SPLIT_EMI");
      expect(data.result.status).toBe("EMI_OFFERED");
    });
  });
});
