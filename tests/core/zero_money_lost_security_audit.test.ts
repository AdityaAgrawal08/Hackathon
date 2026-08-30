import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app, dbClient } from "../../app/server.js";

describe("Security & Invariant Tests", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe("Amount Sanitization & Input Validation", () => {
    it("rejects order creation with invalid product", async () => {
      const res = await fetch(`${baseUrl}/api/orders/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "nonexistent_product",
          customerName: "Test",
          customerPhone: "+91 9999999999",
          customerEmail: "test@test.com",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects order creation with empty body", async () => {
      const res = await fetch(`${baseUrl}/api/orders/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("rejects payment verification with missing signature", async () => {
      const res = await fetch(`${baseUrl}/api/payments/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          razorpay_payment_id: "pay_test",
          razorpay_order_id: "order_test",
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("Vendor Decision Security", () => {
    it("rejects invalid decision values", async () => {
      const res = await fetch(`${baseUrl}/api/vendor/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: "test", decision: "invalid" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects decision without eventId", async () => {
      const res = await fetch(`${baseUrl}/api/vendor/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("Webhook Security", () => {
    it("accepts webhook with valid structure", async () => {
      const payload = JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: {
              id: "pay_test_123",
              order_id: "order_test_123",
              amount: 199900,
              status: "captured",
            },
          },
        },
      });

      const res = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-razorpay-signature": "test_signature",
        },
        body: payload,
      });
      // Should ACK even if signature verification fails (test mode)
      expect(res.status).toBe(200);
    });

    it("handles payment.failed webhook event", async () => {
      const payload = JSON.stringify({
        event: "payment.failed",
        payload: {
          payment: {
            entity: {
              id: "pay_fail_test",
              order_id: "order_fail_test",
              amount: 99900,
              status: "failed",
              error_code: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
              error_description: "Insufficient funds",
              error_step: "payment_authorization",
              error_source: "customer",
              error_reason: "insufficient_funds",
            },
          },
        },
      });

      const res = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-razorpay-signature": "test_signature",
        },
        body: payload,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.received).toBe(true);
    });
  });

  describe("SSE Security", () => {
    it("establishes SSE connection", async () => {
      const controller = new AbortController();
      const res = await fetch(`${baseUrl}/api/sse/test`, {
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      controller.abort();
    });
  });

  describe("Concurrent Order Creation", () => {
    it("handles 10 concurrent order creation requests", async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        fetch(`${baseUrl}/api/orders/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            productId: "prod_monthly_basic",
            customerName: `Security Test ${i}`,
            customerPhone: `+91 88888${String(i).padStart(5, "0")}`,
            customerEmail: `security${i}@test.com`,
          }),
        }).then((res) => res.json())
      );

      const results = await Promise.all(promises);
      const orderIds = new Set(results.map((r) => r.orderId));
      expect(orderIds.size).toBe(10);
    });
  });
});
