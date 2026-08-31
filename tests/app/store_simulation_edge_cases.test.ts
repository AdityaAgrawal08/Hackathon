import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app, dbClient } from "../../app/server.js";

describe("Store & Payment Workflow Edge-Case Tests", () => {
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

  it("rejects order creation with missing customer name", async () => {
    const res = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: "prod_monthly_basic",
        customerPhone: "+91 98765 43210",
        customerEmail: "test@example.com",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects order creation with missing phone", async () => {
    const res = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: "prod_monthly_basic",
        customerName: "Test User",
        customerEmail: "test@example.com",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects order creation with missing email", async () => {
    const res = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: "prod_monthly_basic",
        customerName: "Test User",
        customerPhone: "+91 98765 43210",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects payment verification with missing fields", async () => {
    const res = await fetch(`${baseUrl}/api/payments/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid vendor decision parameters", async () => {
    const res1 = await fetch(`${baseUrl}/api/vendor/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: "test", decision: "invalid" }),
    });
    expect(res1.status).toBe(400);

    const res2 = await fetch(`${baseUrl}/api/vendor/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(res2.status).toBe(400);
  });

  it("handles concurrent order creation without race conditions", async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      fetch(`${baseUrl}/api/orders/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "prod_monthly_basic",
          customerName: `Concurrent User ${i}`,
          customerPhone: `+91 ${9000000000 + i}`,
          customerEmail: `concurrent${i}@test.com`,
        }),
      })
    );

    const results = await Promise.all(promises);
    for (const res of results) {
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.orderId).toBeDefined();
      expect(data.customerId).toBeDefined();
    }

    // Verify all customers were created
    const customers = await dbClient.execute("SELECT COUNT(*) as count FROM customer_profiles");
    expect(Number(customers.rows[0]?.count || 0)).toBeGreaterThanOrEqual(5);
  });

  it("serves store page with product grid", async () => {
    const res = await fetch(`${baseUrl}/store`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Premium Annual Plan");
    expect(html).toContain("Monthly Basic");
    expect(html).toContain("Team License");
    expect(html).toContain("Enterprise");
    expect(html).toContain("checkout.razorpay.com");
  });

  it("serves dashboard with live feed", async () => {
    const res = await fetch(`${baseUrl}/dashboard`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Vendor Dashboard");
    expect(html).toContain("Transactions");
    expect(html).toContain("Suspicious Activity");
  });

  it("serves recovery page", async () => {
    const res = await fetch(`${baseUrl}/recover/test-event-id`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Payment Could Not Be Processed");
    expect(html).toContain("checkout.razorpay.com");
  });
});
