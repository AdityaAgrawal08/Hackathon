import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app, dbClient } from "../../app/server.js";

describe("End-to-End Payment Workflow Integration", () => {
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

  it("creates order with customer info and returns Razorpay params", async () => {
    const orderRes = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: "prod_monthly_basic",
        customerName: "E2E Test Customer",
        customerPhone: "+91 99999 88888",
        customerEmail: "e2e@test.com",
      }),
    });
    expect(orderRes.status).toBe(200);
    const data = await orderRes.json();
    expect(data.orderId).toBeDefined();
    expect(data.amountPaise).toBe(99900);
    expect(data.currency).toBe("INR");
    expect(data.customerId).toBeDefined();
    expect(data.keyId).toBeDefined();
  });

  it("rejects order creation with missing fields", async () => {
    const res = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: "prod_monthly_basic" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects order creation with invalid product", async () => {
    const res = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: "nonexistent",
        customerName: "Test",
        customerPhone: "+91 99999 88888",
        customerEmail: "test@test.com",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns vendor analytics with correct structure", async () => {
    const res = await fetch(`${baseUrl}/api/vendor/analytics`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("totalEvents");
    expect(data).toHaveProperty("totalSuccesses");
    expect(data).toHaveProperty("totalFailures");
    expect(data).toHaveProperty("recoveredPaise");
    expect(data).toHaveProperty("successRate");
  });

  it("handles vendor decision endpoint", async () => {
    const orderRes = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: "prod_team_license",
        customerName: "Decision Test",
        customerPhone: "+91 77777 66666",
        customerEmail: "decision@test.com",
      }),
    });
    const orderData = await orderRes.json();

    const eventId = `evt_test_${Date.now()}`;
    await dbClient.execute({
      sql: `INSERT INTO live_payment_events
        (id, customer_profile_id, product_name, amount_paise, status, failure_class, vendor_notified, created_at_utc)
        VALUES (?, ?, 'Team License', 199900, 'failed', 'SOFT_RETRYABLE', 1, ?)`,
      args: [eventId, orderData.customerId, new Date().toISOString()],
    });

    const approveRes = await fetch(`${baseUrl}/api/vendor/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId, decision: "approved" }),
    });
    expect(approveRes.status).toBe(200);
  });

  it("serves SSE endpoint", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/sse/global`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
  });
});
