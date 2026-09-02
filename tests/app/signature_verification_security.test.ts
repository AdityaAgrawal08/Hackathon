import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import { app, dbClient } from "../../app/server.js";

describe("Payment Signature Verification & Security (SEC-01)", () => {
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

  it("rejects request if missing verification fields", async () => {
    const res = await fetch(`${baseUrl}/api/payments/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        razorpay_payment_id: "pay_test123",
        // missing order_id & signature
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Missing payment verification fields");
  });

  it("rejects request with invalid signature format (non-hex)", async () => {
    const res = await fetch(`${baseUrl}/api/payments/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        razorpay_payment_id: "pay_test123",
        razorpay_order_id: "order_test123",
        razorpay_signature: "not_a_valid_hex_string_xyz!",
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/Invalid signature/i);
  });

  it("rejects forged signature when secret is configured", async () => {
    const fakeOrder = "order_test999";
    const fakePayment = "pay_test999";
    const forgedSignature = createHmac("sha256", "wrong_secret_key")
      .update(`${fakeOrder}|${fakePayment}`)
      .digest("hex");

    const res = await fetch(`${baseUrl}/api/payments/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        razorpay_payment_id: fakePayment,
        razorpay_order_id: fakeOrder,
        razorpay_signature: forgedSignature,
      }),
    });

    // In environment with secret or strict check, should be 400
    expect(res.status).toBe(400);
  });

  it("alias /api/payment-success enforces identical verification", async () => {
    const res = await fetch(`${baseUrl}/api/payment-success`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        razorpay_payment_id: "pay_test123",
        // missing order_id & signature
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Missing payment verification fields");
  });
});
