import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import { app, dbClient } from "../../app/server.js";
import { runMigrations } from "../../packages/core/src/db/migrate.js";

describe("Customer Retention & Multi-Action Recovery Portal (PORTAL-01 & PRUNE-02)", () => {
  let server: Server;
  let baseUrl: string;
  let testEventId: string;
  let testCustomerId: string;
  const testOrderId = `order_portal_${Date.now()}`;
  const RZP_SECRET = process.env.RZP_TEST_KEY_SECRET || process.env.RZP_KEY_SECRET || "rzp_test_secret";

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

    testCustomerId = `cust_portal_${Date.now()}`;
    testEventId = `evt_portal_${Date.now()}`;
    const uniquePhone = `+9198${Date.now().toString().slice(-8)}`;
    const nowUtc = new Date().toISOString();

    // Seed customer profile
    await dbClient.execute({
      sql: `INSERT OR REPLACE INTO customer_profiles (id, name, phone, email, created_at_utc, total_attempts, total_failures)
            VALUES (?, 'Aarav Patel', ?, 'aarav@example.com', ?, 1, 1)`,
      args: [testCustomerId, uniquePhone, nowUtc],
    });

    // Seed live payment failure
    await dbClient.execute({
      sql: `INSERT INTO live_payment_events
        (id, customer_profile_id, product_name, amount_paise, status, failure_code, failure_class, created_at_utc)
        VALUES (?, ?, 'Premium Annual Plan', 499900, 'failed', 'INSUFFICIENT_FUNDS', 'SOFT_RETRYABLE', ?)`,
      args: [testEventId, testCustomerId, nowUtc],
    });

    // Seed 2 scheduled dunning reminders (pending)
    await dbClient.execute({
      sql: `INSERT INTO scheduled_outreach (id, live_payment_event_id, customer_profile_id, channel, scheduled_at_utc, status, executed)
            VALUES (?, ?, ?, 'SMS', ?, 'PENDING', 0)`,
      args: [`sch_test_1_${Date.now()}`, testEventId, testCustomerId, nowUtc],
    });
    await dbClient.execute({
      sql: `INSERT INTO scheduled_outreach (id, live_payment_event_id, customer_profile_id, channel, scheduled_at_utc, status, executed)
            VALUES (?, ?, ?, 'EMAIL', ?, 'PENDING', 0)`,
      args: [`sch_test_2_${Date.now()}`, testEventId, testCustomerId, nowUtc],
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("1-Tap UPI Intent API generates valid NPCI-compliant URI schemes", async () => {
    const res = await fetch(`${baseUrl}/api/recovery/upi-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: testEventId }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.amountPaise).toBe(499900);
    expect(data.rawUpiUri).toContain("upi://pay?pa=");
    expect(data.rawUpiUri).toContain("am=4999.00");
    expect(data.gpayUri).toContain("package=com.google.android.apps.nbu.paisa.user");
    expect(data.phonepeUri).toContain("phonepe://pay");
    expect(data.paytmUri).toContain("paytmmp://pay");
    expect(data.bhimUri).toContain("upi://pay");
  });

  it("Smart Downsell & Split-Pay API generates 3-installment orders", async () => {
    const res = await fetch(`${baseUrl}/api/recovery/downsell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: testEventId,
        downsellType: "split_3",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.downsellId).toMatch(/^dwn_/);
    expect(data.originalAmountPaise).toBe(499900);
    expect(data.amountPaise).toBe(Math.ceil(499900 / 3));
    expect(data.orderId).toBeDefined();

    // Verify DB record in downsell_offers
    const downsellRow = await dbClient.execute({
      sql: `SELECT * FROM downsell_offers WHERE id = ?`,
      args: [data.downsellId],
    });
    expect(downsellRow.rows.length).toBe(1);
    expect(downsellRow.rows[0].status).toBe("OFFERED");
  });

  it("Payment Verification instantly prunes pending reminders and appends cryptographic audit ledger", async () => {
    const paymentId = `pay_recovered_${Date.now()}`;
    const signaturePayload = `${testOrderId}|${paymentId}`;
    const validSignature = createHmac("sha256", RZP_SECRET).update(signaturePayload).digest("hex");

    const res = await fetch(`${baseUrl}/api/payments/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        razorpay_payment_id: paymentId,
        razorpay_order_id: testOrderId,
        razorpay_signature: validSignature,
        orderId: testOrderId,
        customerId: testCustomerId,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.status).toBe("captured");

    // Invariant Check: Pending scheduled outreach for customer is now CANCELLED
    const outreachRows = await dbClient.execute({
      sql: `SELECT status, cancelled_reason FROM scheduled_outreach WHERE customer_profile_id = ?`,
      args: [testCustomerId],
    });
    expect(outreachRows.rows.length).toBeGreaterThan(0);
    for (const r of outreachRows.rows) {
      expect(r.status).toBe("CANCELLED");
    }
    expect(outreachRows.rows.some(r => r.cancelled_reason === "PAYMENT_COMPLETED")).toBe(true);

    // Invariant Check: Cryptographic audit ledger contains RECOVERY_COMPLETED
    const auditRows = await dbClient.execute({
      sql: `SELECT * FROM audit_ledger WHERE customer_id = ? ORDER BY created_at_utc DESC LIMIT 1`,
      args: [testCustomerId],
    });
    expect(auditRows.rows.length).toBe(1);
    expect(auditRows.rows[0].event_type).toBe("RECOVERY_COMPLETED");
    expect(auditRows.rows[0].entry_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
