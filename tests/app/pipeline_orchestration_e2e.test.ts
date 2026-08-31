import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app, dbClient } from "../../app/server.js";
import { runMigrations } from "../../packages/core/src/db/migrate.js";

describe("End-to-End Payment Workflow Integration Tests", () => {
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
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    }
  });

  it("creates order and customer profile via /api/orders/create", async () => {
    const res = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: "prod_premium_plan",
        customerName: "Pipeline Test User",
        customerPhone: "+91 88888 77777",
        customerEmail: "pipeline@test.com",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.orderId).toBeDefined();
    expect(data.amountPaise).toBe(499900);
    expect(data.customerId).toBeDefined();
  });

  it("returns vendor payments list with customer join", async () => {
    const res = await fetch(`${baseUrl}/api/vendor/payments`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it("returns vendor alerts for suspicious activity", async () => {
    const res = await fetch(`${baseUrl}/api/vendor/alerts`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it("handles vendor approval decision", async () => {
    // Create customer
    const orderRes = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: "prod_enterprise",
        customerName: "Approval Test",
        customerPhone: "+91 66666 55555",
        customerEmail: "approval@test.com",
      }),
    });
    const orderData = (await orderRes.json()) as { customerId: string };

    // Insert suspicious event
    const eventId = `evt_alert_${Date.now()}`;
    await dbClient.execute({
      sql: `INSERT INTO live_payment_events
        (id, customer_profile_id, product_name, amount_paise, status, failure_class, vendor_notified, created_at_utc)
        VALUES (?, ?, 'Enterprise', 999900, 'failed', 'RISK_FLAGGED', 1, ?)`,
      args: [eventId, orderData.customerId, new Date().toISOString()],
    });

    // Approve
    const approveRes = await fetch(`${baseUrl}/api/vendor/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId, decision: "approved" }),
    });
    expect(approveRes.status).toBe(200);

    // Verify
    const event = await dbClient.execute({
      sql: "SELECT vendor_decision, outreach_dispatched FROM live_payment_events WHERE id = ?",
      args: [eventId],
    });
    expect(event.rows[0]?.vendor_decision).toBe("approved");
  });

  it("handles vendor rejection decision", async () => {
    const orderRes = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: "prod_monthly_basic",
        customerName: "Rejection Test",
        customerPhone: "+91 55555 44444",
        customerEmail: "reject@test.com",
      }),
    });
    const orderData = (await orderRes.json()) as { customerId: string };

    const eventId = `evt_reject_${Date.now()}`;
    await dbClient.execute({
      sql: `INSERT INTO live_payment_events
        (id, customer_profile_id, product_name, amount_paise, status, failure_class, vendor_notified, created_at_utc)
        VALUES (?, ?, 'Monthly Basic', 99900, 'failed', 'UNKNOWN', 1, ?)`,
      args: [eventId, orderData.customerId, new Date().toISOString()],
    });

    const rejectRes = await fetch(`${baseUrl}/api/vendor/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId, decision: "rejected" }),
    });
    expect(rejectRes.status).toBe(200);

    const event = await dbClient.execute({
      sql: "SELECT vendor_decision FROM live_payment_events WHERE id = ?",
      args: [eventId],
    });
    expect(event.rows[0]?.vendor_decision).toBe("rejected");
  });

  it("SSE endpoint returns event stream", async () => {
    const res = await fetch(`${baseUrl}/api/sse/vendor:alerts`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });
});
