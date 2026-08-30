import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app, dbClient } from "../../app/server.js";

describe("Concurrency, Failover & Re-Entrancy Invariants", () => {
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

  describe("High-Concurrency Burst Stress", () => {
    it("handles 50 concurrent order creation requests with zero race conditions", async () => {
      const burstPromises = Array.from({ length: 50 }, (_, i) => {
        return fetch(`${baseUrl}/api/orders/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            productId: i % 2 === 0 ? "prod_monthly_basic" : "prod_team_license",
            customerName: `Burst Customer ${i}`,
            customerPhone: `+91 98000${String(i).padStart(5, "0")}`,
            customerEmail: `burst${i}@test.com`,
          }),
        }).then((res) => res.json());
      });

      const orders = await Promise.all(burstPromises);
      expect(orders.length).toBe(50);

      // Verify every order has a unique ID
      const orderIds = new Set(orders.map((o) => o.orderId));
      expect(orderIds.size).toBe(50);

      // Verify every customer has a unique ID
      const customerIds = new Set(orders.map((o) => o.customerId));
      expect(customerIds.size).toBe(50);

      // Verify all customers were persisted
      const customers = await dbClient.execute("SELECT COUNT(*) as count FROM customer_profiles");
      expect(Number(customers.rows[0]?.count || 0)).toBeGreaterThanOrEqual(50);
    });

    it("handles concurrent vendor analytics requests without corruption", async () => {
      const promises = Array.from({ length: 10 }, () =>
        fetch(`${baseUrl}/api/vendor/analytics`).then((res) => res.json())
      );

      const results = await Promise.all(promises);
      for (const data of results) {
        expect(data).toHaveProperty("totalEvents");
        expect(data).toHaveProperty("successRate");
      }
    });
  });

  describe("Vendor Decision Re-Entrancy", () => {
    it("handles duplicate vendor decisions idempotently", async () => {
      // Create customer
      const orderRes = await fetch(`${baseUrl}/api/orders/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "prod_premium_plan",
          customerName: "Idempotent Decision Test",
          customerPhone: "+91 77777 11111",
          customerEmail: "idempotent@test.com",
        }),
      });
      const orderData = (await orderRes.json()) as { customerId: string };

      // Insert event
      const eventId = `evt_idem_${Date.now()}`;
      await dbClient.execute({
        sql: `INSERT INTO live_payment_events
          (id, customer_profile_id, product_name, amount_paise, status, failure_class, vendor_notified, created_at_utc)
          VALUES (?, ?, 'Premium Plan', 499900, 'failed', 'SOFT_RETRYABLE', 1, ?)`,
        args: [eventId, orderData.customerId, new Date().toISOString()],
      });

      // Send same decision twice concurrently
      const [res1, res2] = await Promise.all([
        fetch(`${baseUrl}/api/vendor/decision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventId, decision: "approved" }),
        }),
        fetch(`${baseUrl}/api/vendor/decision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventId, decision: "approved" }),
        }),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      // Verify decision is still correct
      const event = await dbClient.execute({
        sql: "SELECT vendor_decision FROM live_payment_events WHERE id = ?",
        args: [eventId],
      });
      expect(event.rows[0]?.vendor_decision).toBe("approved");
    });
  });

  describe("SSE Connection Management", () => {
    it("handles multiple SSE connections on same channel", async () => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();

      const res1 = await fetch(`${baseUrl}/api/sse/test-channel`, {
        signal: controller1.signal,
      });
      const res2 = await fetch(`${baseUrl}/api/sse/test-channel`, {
        signal: controller2.signal,
      });

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      controller1.abort();
      controller2.abort();
    });
  });
});
