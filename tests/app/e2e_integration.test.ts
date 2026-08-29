import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, dbClient, localGateway } from "../../app/server.js";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";

describe("End-to-End Payment Infrastructure & Recovery Integration", () => {
  let serverInstance: { app: unknown; server: Server; sweeperInterval: NodeJS.Timeout };
  const baseUrl = "http://127.0.0.1:3000";

  beforeAll(async () => {
    serverInstance = await startServer();
  });

  afterAll(async () => {
    clearInterval(serverInstance.sweeperInterval);
    await new Promise<void>((resolve) => serverInstance.server.close(() => resolve()));
  });

  it("completes full order creation -> mobile pay -> charge -> settlement lifecycle", async () => {
    // 1. Create order
    const orderRes = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountPaise: 49900, paymentMode: "LOCAL_SANDBOX" }),
    });
    expect(orderRes.status).toBe(200);
    const orderData = (await orderRes.json()) as {
      token: string;
      orderId: string;
      qrCodeDataUrl: string;
      mobileUrl: string;
    };
    expect(orderData.token).toBeDefined();
    expect(orderData.qrCodeDataUrl).toContain("data:image/png;base64,");

    // 2. Fetch mobile payment page using token
    const pageRes = await fetch(`${baseUrl}/pay/${orderData.token}`);
    expect(pageRes.status).toBe(200);
    const html = await pageRes.text();
    expect(html).toContain("Order:");
    expect(html).toContain(orderData.orderId);

    // 3. Submit charge with LOCAL_SUCCESS
    const chargeRes = await fetch(`${baseUrl}/api/payments/charge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: orderData.token,
        clientIdemKey: `idem_e2e_${Date.now()}`,
        scenario: "LOCAL_SUCCESS",
      }),
    });
    expect(chargeRes.status).toBe(200);
    const chargeData = (await chargeRes.json()) as { knowledgeStatus: string; userMessage: string };
    expect(chargeData.knowledgeStatus).toBe("RESOLVED_SUCCESS");
    expect(chargeData.userMessage).toContain("Thank you — your payment of ₹499.00 was received.");

    // 4. Verify durable settlement projection in SQLite
    const settlements = await dbClient.execute(`SELECT * FROM local_settlements WHERE idem_key LIKE 'idem_e2e_%'`);
    expect(settlements.rows.length).toBeGreaterThan(0);
  });

  it("handles decline scenario with empathetic messaging and advisory classification", async () => {
    const orderRes = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountPaise: 199900, paymentMode: "LOCAL_SANDBOX" }),
    });
    const orderData = (await orderRes.json()) as { token: string };

    const chargeRes = await fetch(`${baseUrl}/api/payments/charge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: orderData.token,
        clientIdemKey: `idem_decline_${Date.now()}`,
        scenario: "LOCAL_INSUFFICIENT_FUNDS",
      }),
    });

    expect(chargeRes.status).toBe(400);
    const chargeData = (await chargeRes.json()) as { knowledgeStatus: string; userMessage: string; userMessageHi: string };
    expect(chargeData.knowledgeStatus).toBe("RESOLVED_FAILED");
    expect(chargeData.userMessage).toContain("insufficient balance");
    expect(chargeData.userMessageHi).toContain("पर्याप्त बैलेंस नहीं था");
  });

  it("accepts and acknowledges verified webhooks in <100ms", async () => {
    const rawBody = JSON.stringify({
      id: `evt_e2e_${Date.now()}`,
      event: "payment.captured",
      payload: { payment: { entity: { id: `pay_e2e_${Date.now()}`, order_id: "order_123", amount: 49900 } } },
    });
    const sig = createHmac("sha256", "whsec_local_test_secret_12345").update(rawBody).digest("hex");

    const t0 = Date.now();
    const res = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": sig,
      },
      body: rawBody,
    });
    const duration = Date.now() - t0;

    expect(res.status).toBe(200);
    expect(duration).toBeLessThan(100);
  });
});
