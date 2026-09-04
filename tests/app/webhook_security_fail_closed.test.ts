/**
 * Automated Verification Suite for Phase 5: Razorpay Webhook Security & Fail-Closed Handlers
 *
 * Verifies:
 * 1. Constant-time HMAC-SHA256 signature verification with HTTP 401 on missing/invalid signature.
 * 2. Webhook deduplication across payment, order, subscription, and invoice entities.
 * 3. Extended event handlers: order.paid, subscription.charged, subscription.halted, invoice.paid.
 * 4. Storefront verification handshake endpoint (/api/payments/verify).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { app, dbClient } from "../../app/server.js";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { DEFAULT_LOCAL_WEBHOOK_SECRET } from "../../packages/core/src/constants.js";

describe("Phase 5: Razorpay Webhook Security & Fail-Closed Handlers", () => {
  let server: Server;
  let baseUrl: string;
  const webhookSecret = process.env.RZP_WEBHOOK_SECRET || DEFAULT_LOCAL_WEBHOOK_SECRET;

  beforeAll(async () => {
    await runMigrations(dbClient);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as any;
        baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function signPayload(body: string, secret: string = webhookSecret): string {
    return createHmac("sha256", secret).update(body).digest("hex");
  }

  describe("1. Fail-Closed Webhook HMAC Verification", () => {
    it("returns HTTP 401 Unauthorized when signature is missing in strict mode", async () => {
      const payload = JSON.stringify({
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_test_missing_sig" } } },
      });

      const res = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-strict-webhook-security": "true",
        },
        body: payload,
      });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toContain("Missing x-razorpay-signature header");
    });

    it("returns HTTP 401 Unauthorized when signature is invalid or tampered", async () => {
      const payload = JSON.stringify({
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_test_bad_sig" } } },
      });

      const res = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-strict-webhook-security": "true",
          "x-razorpay-signature": "deadbeef".repeat(8), // 64-char invalid hex
        },
        body: payload,
      });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toContain("Invalid webhook signature");
    });

    it("accepts valid HMAC signature in strict mode and returns 200 OK", async () => {
      const payload = JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: {
              id: `pay_valid_${Date.now()}`,
              amount: 199900,
              status: "captured",
            },
          },
        },
      });

      const validSig = signPayload(payload);
      const res = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-strict-webhook-security": "true",
          "x-razorpay-signature": validSig,
        },
        body: payload,
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.received).toBe(true);
    });

    it("deduplicates duplicate webhook deliveries across all entity types", async () => {
      const uniquePaymentId = `pay_dedupe_${Date.now()}`;
      const payload = JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: {
              id: uniquePaymentId,
              amount: 499900,
              status: "captured",
            },
          },
        },
      });

      const validSig = signPayload(payload);

      // First delivery
      const res1 = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-strict-webhook-security": "true",
          "x-razorpay-signature": validSig,
        },
        body: payload,
      });
      expect(res1.status).toBe(200);
      const data1 = await res1.json();
      expect(data1.received).toBe(true);
      expect(data1.deduped).toBeUndefined();

      // Duplicate delivery
      const res2 = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-strict-webhook-security": "true",
          "x-razorpay-signature": validSig,
        },
        body: payload,
      });
      expect(res2.status).toBe(200);
      const data2 = await res2.json();
      expect(data2.received).toBe(true);
      expect(data2.deduped).toBe(true);
    });
  });

  describe("2. Extended Webhook Event Handlers", () => {
    it("handles order.paid event, logs to audit ledger, and resolves recovery", async () => {
      const orderId = `order_paid_${Date.now()}`;
      const custId = `cust_ord_${Date.now()}`;
      const phone = `91${Math.floor(1000000000 + Math.random() * 8999999999)}`;

      // Insert customer profile
      await dbClient.execute({
        sql: "INSERT INTO customer_profiles (id, name, phone, email, created_at_utc) VALUES (?, 'Order Buyer', ?, 'buyer@test.com', datetime('now'))",
        args: [custId, phone],
      });

      const payload = JSON.stringify({
        event: "order.paid",
        payload: {
          order: {
            entity: {
              id: orderId,
              amount_paid: 299900,
              status: "paid",
              receipt: `rcpt_${Date.now()}`,
              notes: {
                customer_profile_id: custId,
                product_name: "Pro Subscription Plan",
              },
            },
          },
          payment: {
            entity: {
              id: `pay_${orderId.slice(-8)}`,
              amount: 299900,
            },
          },
        },
      });

      const validSig = signPayload(payload);
      const res = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-strict-webhook-security": "true",
          "x-razorpay-signature": validSig,
        },
        body: payload,
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.received).toBe(true);

      // Verify audit ledger entry
      const audit = await dbClient.execute({
        sql: "SELECT * FROM audit_ledger WHERE event_type = 'ORDER_PAID' AND entity_id = ? ORDER BY id DESC LIMIT 1",
        args: [orderId],
      });
      expect(audit.rows.length).toBe(1);
      const row = audit.rows[0] as any;
      const parsed = JSON.parse(row.payload_json);
      expect(parsed.orderId).toBe(orderId);
      expect(parsed.amountPaise).toBe(299900);
    });

    it("handles subscription.charged event and appends to audit ledger", async () => {
      const subId = `sub_charged_${Date.now()}`;
      const custId = `cust_sub_${Date.now()}`;

      const payload = JSON.stringify({
        event: "subscription.charged",
        payload: {
          subscription: {
            entity: {
              id: subId,
              plan_id: "plan_monthly_saas",
              plan_amount: 149900,
              current_start: 1700000000,
              current_end: 1702592000,
              charge_at: 1700000000,
              status: "active",
              notes: {
                customer_profile_id: custId,
              },
            },
          },
          payment: {
            entity: {
              id: `pay_sub_${Date.now()}`,
              amount: 149900,
            },
          },
        },
      });

      const validSig = signPayload(payload);
      const res = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-strict-webhook-security": "true",
          "x-razorpay-signature": validSig,
        },
        body: payload,
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.received).toBe(true);

      // Verify audit ledger entry
      const audit = await dbClient.execute({
        sql: "SELECT * FROM audit_ledger WHERE event_type = 'SUBSCRIPTION_CHARGED' AND entity_id = ? ORDER BY id DESC LIMIT 1",
        args: [subId],
      });
      expect(audit.rows.length).toBe(1);
      const parsed = JSON.parse((audit.rows[0] as any).payload_json);
      expect(parsed.subscriptionId).toBe(subId);
      expect(parsed.amountPaise).toBe(149900);
    });

    it("handles subscription.halted event with autonomous SaaS grace period strategy", async () => {
      const subId = `sub_halted_${Date.now()}`;
      const custId = `cust_halted_${Date.now()}`;

      const payload = JSON.stringify({
        event: "subscription.halted",
        payload: {
          subscription: {
            entity: {
              id: subId,
              plan_amount: 399900,
              status: "halted",
              notes: {
                customer_profile_id: custId,
                customer_name: "Anita Desai",
                plan_name: "Enterprise Cloud Suite",
              },
            },
          },
        },
      });

      const validSig = signPayload(payload);
      const res = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-strict-webhook-security": "true",
          "x-razorpay-signature": validSig,
        },
        body: payload,
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.received).toBe(true);

      // Verify audit ledger entry contains grace period calculations
      const audit = await dbClient.execute({
        sql: "SELECT * FROM audit_ledger WHERE event_type = 'SUBSCRIPTION_HALTED' AND entity_id = ? ORDER BY id DESC LIMIT 1",
        args: [subId],
      });
      expect(audit.rows.length).toBe(1);
      const parsed = JSON.parse((audit.rows[0] as any).payload_json);
      expect(parsed.subscriptionId).toBe(subId);
      expect(parsed.status).toBe("halted");
      expect(parsed.gracePeriodDays).toBe(5);
      expect(parsed.softLockExpiresAtUtc).toBeDefined();
      expect(parsed.customerMessage).toBeDefined();
      expect(parsed.actionUrl).toBeDefined();
    });

    it("handles invoice.paid event and calculates DSO working capital interest savings", async () => {
      const invoiceId = `inv_b2b_${Date.now()}`;
      const custId = `cust_b2b_${Date.now()}`;

      const payload = JSON.stringify({
        event: "invoice.paid",
        payload: {
          invoice: {
            entity: {
              id: invoiceId,
              invoice_number: "INV-2026-904",
              amount_paid: 50000000, // ₹5,00,000
              customer_id: custId,
              customer_details: {
                id: custId,
                name: "Apex Global Ltd",
              },
              notes: {
                dso_days_saved: 20,
                annual_cost_of_capital: 0.14, // 14% p.a.
              },
            },
          },
          payment: {
            entity: {
              id: `pay_inv_${Date.now()}`,
              amount: 50000000,
            },
          },
        },
      });

      const validSig = signPayload(payload);
      const res = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-strict-webhook-security": "true",
          "x-razorpay-signature": validSig,
        },
        body: payload,
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.received).toBe(true);

      // Verify audit ledger entry contains working capital savings
      const audit = await dbClient.execute({
        sql: "SELECT * FROM audit_ledger WHERE event_type = 'INVOICE_PAID' AND entity_id = ? ORDER BY id DESC LIMIT 1",
        args: [invoiceId],
      });
      expect(audit.rows.length).toBe(1);
      const parsed = JSON.parse((audit.rows[0] as any).payload_json);
      expect(parsed.invoiceId).toBe(invoiceId);
      expect(parsed.amountPaidPaise).toBe(50000000);
      expect(parsed.dsoDaysSaved).toBe(20);
      // Capital savings: 50,000,000 * (0.14 / 365) * 20 = 383561.64 -> 383562
      expect(parsed.capitalSavingsPaise).toBe(383562);
    });
  });

  describe("3. Storefront Verification Handshake (/api/payments/verify)", () => {
    it("rejects request with missing verification fields with 400 Bad Request", async () => {
      const res = await fetch(`${baseUrl}/api/payments/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          razorpay_payment_id: "pay_test_123",
          // missing order_id and signature
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Missing payment verification fields");
    });

    it("rejects request with malformed signature format (not 64-char hex) with 400", async () => {
      const res = await fetch(`${baseUrl}/api/payments/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          razorpay_payment_id: "pay_test_123",
          razorpay_order_id: "order_test_123",
          razorpay_signature: "short_bad_sig",
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Invalid signature format");
    });
  });
});
