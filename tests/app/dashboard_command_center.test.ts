import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app, dbClient } from "../../app/server.js";
import { runMigrations } from "../../packages/core/src/db/migrate.js";

describe("Vendor Dashboard Integration Tests", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await runMigrations(dbClient);
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

  it("serves the vendor dashboard at /dashboard", async () => {
    const res = await fetch(`${baseUrl}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("ARBITER");
    expect(html).toContain("Vendor Dashboard");
  });

  it("serves the store at /store", async () => {
    const res = await fetch(`${baseUrl}/store`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("ARBITER");
    expect(html).toContain("Premium Annual Plan");
  });

  it("returns product list via /api/products", async () => {
    const res = await fetch(`${baseUrl}/api/products`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(4);
    expect(data[0].id).toBe("prod_premium_plan");
  });

  it("creates a Razorpay order via /api/orders/create", async () => {
    const res = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: "prod_monthly_basic",
        customerName: "Test Customer",
        customerPhone: "+91 98765 43210",
        customerEmail: "test@example.com",
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.orderId).toBeDefined();
    expect(data.amountPaise).toBe(99900);
    expect(data.currency).toBe("INR");
    expect(data.customerId).toBeDefined();
  });

  it("rejects order creation with missing fields", async () => {
    const res = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: "prod_monthly_basic" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns vendor payments list", async () => {
    const res = await fetch(`${baseUrl}/api/vendor/payments`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it("returns vendor analytics", async () => {
    const res = await fetch(`${baseUrl}/api/vendor/analytics`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.totalEvents).toBeDefined();
    expect(data.successRate).toBeDefined();
  });

  it("returns vendor alerts", async () => {
    const res = await fetch(`${baseUrl}/api/vendor/alerts`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it("rejects invalid vendor decision", async () => {
    const res = await fetch(`${baseUrl}/api/vendor/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: "invalid", decision: "invalid" }),
    });
    expect(res.status).toBe(400);
  });
});
