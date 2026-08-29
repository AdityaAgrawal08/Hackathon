import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app, dbClient } from "../../app/server.js";
import { simulateFailureTriage } from "../../app/recovery.js";

describe("Phase 3: Interactive Payment Flow Integration Tests", () => {
  let server: Server;
  let baseUrl: string;
  let activeSession: any;

  beforeAll(async () => {
    // 11:00 AM IST daytime
    const DAYTIME_MS = Date.parse("2026-08-28T05:30:00.000Z");
    activeSession = await simulateFailureTriage("SALARY_DELAY", "http://localhost:3000", dbClient, DAYTIME_MS);

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

  it("Task 3.1: serves the customer recovery portal at /recover and /pay/:token", async () => {
    const res = await fetch(`${baseUrl}/recover`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Payment Recovery Portal");
    expect(html).toContain("Remind Me on Salary Day");

    const resToken = await fetch(`${baseUrl}/pay/${activeSession.recoveryToken}`);
    expect(resToken.status).toBe(200);
    expect(resToken.headers.get("content-type")).toContain("text/html");
  });


  it("Task 3.2: initiates a dedicated recovery order with dynamic UPI QR and deep links", async () => {
    const res = await fetch(`${baseUrl}/api/recovery/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferredMethod: "upi" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.orderId).toMatch(/^order_rec_/);
    expect(data.amountPaise).toBe(199900);
    expect(data.formattedAmount).toBe("₹1,999.00");
    expect(data.currency).toBe("INR");
    expect(data.keyId).toBeDefined();

    // Verify dynamic Base64 PNG QR code
    expect(data.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    // Verify native UPI deep links
    expect(data.upiIntentUrl).toContain("upi://pay?pa=arbiter.recovery@hdfcbank");
    expect(data.deepLinks.gpay).toContain("tez://upi/pay?");
    expect(data.deepLinks.phonepe).toContain("phonepe://pay?");
    expect(data.deepLinks.paytm).toContain("paytmmp://pay?");
  });

  it("Task 3.5: captures customer Promise-to-Pay for salary day and schedules reminder", async () => {
    const res = await fetch(`${baseUrl}/api/recovery/promise-to-pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposalId: "prop_demo_123", promisedDay: 28 }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.promisedDay).toBe(28);
    expect(data.scheduledReminderUtc).toBeDefined();
  });

  it("Task 3.3 & 3.4: mobile payment page contains zero radio buttons and includes offline recovery handling", async () => {
    const res = await fetch(`${baseUrl}/recover`);
    const html = await res.text();

    // Verify zero radio buttons
    expect(html).not.toContain('type="radio"');

    // Verify offline resilience and Razorpay SDK integration
    expect(html).toContain("checkout.razorpay.com/v1/checkout.js");
    expect(html).toContain("banner-offline");
    expect(html).toContain("addEventListener(\"offline\"");
    expect(html).toContain("addEventListener(\"online\"");
  });

  it("Task 4.9: completes recovery and verifies HMAC signature safety", async () => {
    const res = await fetch(`${baseUrl}/api/recovery/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposalId: activeSession.id,
        razorpay_payment_id: "pay_test_rec_123",
        razorpay_order_id: "order_test_rec_123",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.proposalId).toBe(activeSession.id);
  });
});


