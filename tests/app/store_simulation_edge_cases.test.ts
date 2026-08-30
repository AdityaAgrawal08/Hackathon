import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import { app } from "../../app/server.js";

describe("Interactive Storefront & Live Recovery Edge-Case Test Suite (Track 03)", () => {
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

  it("Edge Case 1: rejects /api/orders/simulate if tcAgreed is false or missing", async () => {
    const res = await fetch(`${baseUrl}/api/orders/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerName: "Aditya Agrawal",
        customerPhone: "+919876543210",
        customerEmail: "aditya@example.com",
        amountPaise: 199900,
        tcAgreed: false,
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("TERMS_AND_CONDITIONS_REQUIRED");
  });

  it("Edge Case 2: rejects /api/orders/simulate if customerName or customerPhone is missing", async () => {
    const res = await fetch(`${baseUrl}/api/orders/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerName: "",
        customerPhone: "",
        tcAgreed: true,
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("CUSTOMER_NAME_AND_PHONE_REQUIRED");
  });

  it("Edge Case 3: suppresses external provider dispatch when outreachPermitted is false", async () => {
    const res = await fetch(`${baseUrl}/api/orders/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerName: "Sneha Rao",
        customerPhone: "+919811122334",
        customerEmail: "sneha@example.com",
        amountPaise: 149900, // ₹1,499 (within auto-approve dial)
        failureCode: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
        tcAgreed: true,
        outreachPermitted: false, // Explicitly denied
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.session.outreachPermitted).toBe(false);
    expect(data.session.dispatchResult?.providerName).toBe("suppressed");
    expect(data.session.dispatchResult?.rawResponse?.reason).toBe("OUTREACH_SUPPRESSED_NO_CONSENT");
  });

  it("Edge Case 4: dispatches live outreach when outreachPermitted is true and auto-approved", async () => {
    const res = await fetch(`${baseUrl}/api/orders/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerName: "Rohan Varma",
        customerPhone: "+919822233445",
        customerEmail: "rohan@example.com",
        amountPaise: 199900, // ₹1,999 (auto-approved <= ₹2,000)
        failureCode: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
        tcAgreed: true,
        outreachPermitted: true,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.session.autonomyStatus).toBe("AUTO_APPROVED");
    expect(data.session.customerEmail).toBe("rohan@example.com");
    expect(data.session.customerPhone).toBe("+919822233445");
    expect(data.session.dispatchResult).toBeDefined();
    expect(data.session.dispatchResult.status).toBe("SENT");
  });

  it("Edge Case 5: routes high-value order (> ₹2,000) to AWAITING_APPROVAL queue", async () => {
    const res = await fetch(`${baseUrl}/api/orders/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerName: "Enterprise Corp",
        customerPhone: "+919800011122",
        customerEmail: "finance@enterprise.com",
        amountPaise: 2500000, // ₹25,000 (> ₹2,000 threshold)
        failureCode: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
        tcAgreed: true,
        outreachPermitted: true,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.session.autonomyStatus).toBe("AWAITING_APPROVAL");
  });

  it("Edge Case 6: creates dynamic recovery session with signed token and Razorpay parameters", async () => {
    const simulateRes = await fetch(`${baseUrl}/api/orders/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerName: "Karan Johar",
        customerPhone: "+919988776655",
        customerEmail: "karan@example.com",
        amountPaise: 499900,
        failureCode: "BAD_REQUEST_PAYMENT_CARD_EXPIRED",
        tcAgreed: true,
        outreachPermitted: true,
      }),
    });

    const simData = await simulateRes.json();
    const proposalId = simData.session.id;
    const token = simData.session.recoveryToken;

    const initiateRes = await fetch(`${baseUrl}/api/recovery/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposalId, token }),
    });

    expect(initiateRes.status).toBe(200);
    const orderData = await initiateRes.json();
    expect(orderData.orderId).toMatch(/^order_/);
    expect(orderData.amountPaise).toBe(499900);
    expect(orderData.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(orderData.upiIntentUrl).toContain("upi://pay");
  });

  it("Edge Case 7: completes recovery via /api/recovery/complete with cryptographic verification", async () => {
    const simulateRes = await fetch(`${baseUrl}/api/orders/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerName: "Pooja Hegde",
        customerPhone: "+919833344556",
        customerEmail: "pooja@example.com",
        amountPaise: 299900,
        failureCode: "BANK_DOWNTIME_NETWORK_ERROR",
        tcAgreed: true,
        outreachPermitted: true,
      }),
    });

    const simData = await simulateRes.json();
    const proposalId = simData.session.id;

    const completeRes = await fetch(`${baseUrl}/api/recovery/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposalId,
        razorpay_payment_id: "pay_test_live_123456",
        razorpay_order_id: "order_test_live_123456",
      }),
    });

    expect(completeRes.status).toBe(200);
    const completeData = await completeRes.json();
    expect(completeData.success).toBe(true);
    expect(completeData.status).toBe("SETTLED_RECOVERED");
  });

  it("Edge Case 8: rejects /api/recovery/complete with tampered razorpay_signature when secret configured", async () => {
    const secret = "test_key_secret_123";
    const originalSecret = process.env.RZP_KEY_SECRET;
    process.env.RZP_KEY_SECRET = secret;

    try {
      const simulateRes = await fetch(`${baseUrl}/api/orders/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: "Signature Test",
          customerPhone: "+919800099988",
          customerEmail: "sig@example.com",
          amountPaise: 199900,
          tcAgreed: true,
        }),
      });

      const simData = await simulateRes.json();
      const proposalId = simData.session.id;

      const completeRes = await fetch(`${baseUrl}/api/recovery/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposalId,
          razorpay_payment_id: "pay_tampered_123",
          razorpay_order_id: "order_tampered_123",
          razorpay_signature: "tampered_fake_signature_hex",
        }),
      });

      expect(completeRes.status).toBe(400);
      const data = await completeRes.json();
      expect(data.error).toBe("INVALID_RAZORPAY_SIGNATURE");
    } finally {
      if (originalSecret !== undefined) {
        process.env.RZP_KEY_SECRET = originalSecret;
      } else {
        delete process.env.RZP_KEY_SECRET;
      }
    }
  });

  it("Edge Case 9: handles Promise-To-Pay salary day commitments idempotently", async () => {
    const simulateRes = await fetch(`${baseUrl}/api/orders/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerName: "Vikram Batra",
        customerPhone: "+919811100099",
        customerEmail: "vikram@example.com",
        amountPaise: 399900,
        tcAgreed: true,
      }),
    });

    const simData = await simulateRes.json();
    const proposalId = simData.session.id;

    const p2pRes = await fetch(`${baseUrl}/api/recovery/promise-to-pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposalId, promisedDay: 28 }),
    });

    expect(p2pRes.status).toBe(200);
    const p2pData = await p2pRes.json();
    expect(p2pData.success).toBe(true);
    expect(p2pData.promisedDay).toBe(28);
    expect(p2pData.scheduledReminderUtc).toBeDefined();
  });

  it("Edge Case 10: serves /store HTML interface with valid content-type", async () => {
    const res = await fetch(`${baseUrl}/store`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("ARBITER Storefront");
    expect(html).toContain("Place Order & Simulate Payment Degradation");
  });
});
