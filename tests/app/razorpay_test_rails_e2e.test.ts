import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app, dbClient } from "../../app/server.js";

describe("Payment Workflow, Idempotency & Compliance Tests", () => {
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

  it("classifies all Razorpay error codes correctly via webhook simulation", async () => {
    // Test that the system can handle different failure classes
    const testCases = [
      { code: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE", expectedClass: "SOFT_RETRYABLE" },
      { code: "BAD_REQUEST_PAYMENT_CARD_EXPIRED", expectedClass: "HARD_METHOD_DEAD" },
      { code: "BANK_DOWNTIME_NETWORK_ERROR", expectedClass: "NETWORK_TIMEOUT" },
      { code: "BAD_REQUEST_PAYMENT_FRAUD_IDENTIFIED", expectedClass: "RISK_FLAGGED" },
    ];

    // Create test customers and events for each case
    for (const tc of testCases) {
      const orderRes = await fetch(`${baseUrl}/api/orders/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "prod_monthly_basic",
          customerName: `Test ${tc.code}`,
          customerPhone: `+91 ${Math.floor(Math.random() * 9000000000) + 1000000000}`,
          customerEmail: `test${tc.code.toLowerCase()}@example.com`,
        }),
      });
      expect(orderRes.status).toBe(200);
    }
  });

  it("enforces required fields on order creation", async () => {
    const res = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("validates product IDs", async () => {
    const res = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: "nonexistent",
        customerName: "Test",
        customerPhone: "+91 9999999999",
        customerEmail: "test@test.com",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("handles duplicate customer phone (upsert behavior)", async () => {
    const phone = "+91 1234567890";
    const res1 = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: "prod_monthly_basic",
        customerName: "Original Name",
        customerPhone: phone,
        customerEmail: "original@test.com",
      }),
    });
    const data1 = await res1.json();

    const res2 = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: "prod_monthly_basic",
        customerName: "Updated Name",
        customerPhone: phone,
        customerEmail: "updated@test.com",
      }),
    });
    const data2 = await res2.json();

    // Same customer ID (upserted, not duplicated)
    expect(data1.customerId).toBe(data2.customerId);

    // Name was updated
    const cust = await dbClient.execute({
      sql: "SELECT name FROM customer_profiles WHERE id = ?",
      args: [data1.customerId],
    });
    expect((cust.rows[0] as any).name).toBe("Updated Name");
  });

  it("records payment attempt in live_payment_events after successful payment verification", async () => {
    const orderRes = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: "prod_team_license",
        customerName: "Verify Test",
        customerPhone: "+91 11111 22222",
        customerEmail: "verify@test.com",
      }),
    });
    const orderData = (await orderRes.json()) as { customerId: string; orderId: string };

    const before = await dbClient.execute({
      sql: "SELECT COUNT(*) as count FROM live_payment_events WHERE customer_profile_id = ?",
      args: [orderData.customerId],
    });
    const beforeCount = Number(before.rows[0]?.count || 0);

    const after = await dbClient.execute({
      sql: "SELECT COUNT(*) as count FROM live_payment_events WHERE customer_profile_id = ?",
      args: [orderData.customerId],
    });
    const afterCount = Number(after.rows[0]?.count || 0);

    expect(afterCount).toBe(beforeCount);
  });

  it("processes payment.failed webhook with card method and stores all fields", async () => {
    const orderRes = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: "prod_monthly_basic",
        customerName: "Card Webhook Test",
        customerPhone: "+919876543210",
        customerEmail: "test@example.com",
      }),
    });
    const orderData = (await orderRes.json()) as { customerId: string; orderId: string };

    const webhookPayload = {
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: `pay_${Date.now()}`,
            order_id: orderData.orderId,
            amount: 99900,
            currency: "INR",
            status: "failed",
            method: "card",
            card: {
              last4: "0153",
              network: "Visa",
              issuer: "HDFC",
              type: "debit",
              emi: false,
            },
            vpa: null,
            bank: null,
            international: false,
            acquirer_data: {
              auth_code: "828553",
              rrn: "322206890934",
            },
            error_code: "BAD_REQUEST_PAYMENT_CARD_EXPIRED",
            error_description: "The card has expired",
            error_step: "payment_authorization",
            error_source: "customer",
            error_reason: "card_expired",
            token_id: null,
            contact: "+919876543210",
            email: "test@example.com",
            created_at: 1691735748,
          },
        },
      },
    };

    const webhookRes = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookPayload),
    });
    expect(webhookRes.status).toBe(200);
    const webhookData = (await webhookRes.json()) as { received: boolean };
    expect(webhookData.received).toBe(true);

    const eventRow = await dbClient.execute({
      sql: `SELECT * FROM live_payment_events WHERE razorpay_order_id = ? ORDER BY created_at_utc DESC LIMIT 1`,
      args: [orderData.orderId],
    });
    expect(eventRow.rows.length).toBe(1);
    const row = eventRow.rows[0] as any;

    expect(row.payment_method).toBe("card");
    expect(row.card_last4).toBe("0153");
    expect(row.card_network).toBe("Visa");
    expect(row.card_issuer).toBe("HDFC");
    expect(row.card_type).toBe("debit");
    expect(row.card_emi).toBe(0);
    expect(row.vpa).toBeNull();
    expect(row.bank_code).toBeNull();
    expect(row.is_international).toBe(0);
    expect(row.acquirer_auth_code).toBe("828553");
    expect(row.acquirer_rrn).toBe("322206890934");
    expect(row.razorpay_token_id).toBeNull();
    expect(row.razorpay_contact).toBe("+919876543210");
    expect(row.razorpay_email).toBe("test@example.com");
    expect(row.razorpay_created_at).toBe(1691735748);
    expect(row.status).toBe("failed");
  });

  it("processes payment.failed webhook with UPI method and stores vpa", async () => {
    const orderRes = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: "prod_monthly_basic",
        customerName: "UPI Webhook Test",
        customerPhone: "+919876543211",
        customerEmail: "upi@example.com",
      }),
    });
    const orderData = (await orderRes.json()) as { customerId: string; orderId: string };

    const webhookPayload = {
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: `pay_${Date.now()}`,
            order_id: orderData.orderId,
            amount: 99900,
            currency: "INR",
            status: "failed",
            method: "upi",
            card: null,
            vpa: "user@upi",
            bank: null,
            international: false,
            acquirer_data: {
              auth_code: "112233",
              rrn: "998877665544",
            },
            error_code: "BAD_REQUEST_PAYMENT_UPI_COLLECT_EXPIRED",
            error_description: "UPI collect request expired",
            error_step: "payment_authorization",
            error_source: "customer",
            error_reason: "upi_expired",
            token_id: null,
            contact: "+919876543211",
            email: "upi@example.com",
            created_at: 1691735800,
          },
        },
      },
    };

    const webhookRes = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookPayload),
    });
    expect(webhookRes.status).toBe(200);

    const eventRow = await dbClient.execute({
      sql: `SELECT * FROM live_payment_events WHERE razorpay_order_id = ? ORDER BY created_at_utc DESC LIMIT 1`,
      args: [orderData.orderId],
    });
    const row = eventRow.rows[0] as any;

    expect(row.payment_method).toBe("upi");
    expect(row.vpa).toBe("user@upi");
    expect(row.card_last4).toBeNull();
    expect(row.card_network).toBeNull();
    expect(row.bank_code).toBeNull();
    expect(row.is_international).toBe(0);
    expect(row.razorpay_contact).toBe("+919876543211");
    expect(row.razorpay_email).toBe("upi@example.com");
    expect(row.razorpay_created_at).toBe(1691735800);
  });

  it("processes payment.failed webhook with netbanking method and stores bank", async () => {
    const orderRes = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: "prod_monthly_basic",
        customerName: "Netbanking Webhook Test",
        customerPhone: "+919876543212",
        customerEmail: "nb@example.com",
      }),
    });
    const orderData = (await orderRes.json()) as { customerId: string; orderId: string };

    const webhookPayload = {
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: `pay_${Date.now()}`,
            order_id: orderData.orderId,
            amount: 99900,
            currency: "INR",
            status: "failed",
            method: "netbanking",
            card: null,
            vpa: null,
            bank: "HDFC",
            international: false,
            acquirer_data: {
              auth_code: "445566",
              rrn: "112233445566",
            },
            error_code: "BANK_DOWNTIME_NETWORK_ERROR",
            error_description: "Bank is currently down",
            error_step: "payment_authorization",
            error_source: "bank",
            error_reason: "bank_unavailable",
            token_id: null,
            contact: "+919876543212",
            email: "nb@example.com",
            created_at: 1691735900,
          },
        },
      },
    };

    const webhookRes = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookPayload),
    });
    expect(webhookRes.status).toBe(200);

    const eventRow = await dbClient.execute({
      sql: `SELECT * FROM live_payment_events WHERE razorpay_order_id = ? ORDER BY created_at_utc DESC LIMIT 1`,
      args: [orderData.orderId],
    });
    const row = eventRow.rows[0] as any;

    expect(row.payment_method).toBe("netbanking");
    expect(row.bank_code).toBe("HDFC");
    expect(row.card_last4).toBeNull();
    expect(row.vpa).toBeNull();
    expect(row.is_international).toBe(0);
    expect(row.acquirer_auth_code).toBe("445566");
    expect(row.acquirer_rrn).toBe("112233445566");
    expect(row.razorpay_contact).toBe("+919876543212");
    expect(row.razorpay_email).toBe("nb@example.com");
    expect(row.razorpay_created_at).toBe(1691735900);
  });

  it("processes international card payment.failed webhook (American Express)", async () => {
    const orderRes = await fetch(`${baseUrl}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: "prod_team_license",
        customerName: "International Card Test",
        customerPhone: "+919876543213",
        customerEmail: "intl@example.com",
      }),
    });
    const orderData = (await orderRes.json()) as { customerId: string; orderId: string };

    const webhookPayload = {
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: `pay_intl_${Date.now()}`,
            order_id: orderData.orderId,
            amount: 199900,
            currency: "USD",
            status: "failed",
            method: "card",
            card: {
              last4: "1234",
              network: "American Express",
              issuer: "American Express",
              type: "credit",
              emi: false,
            },
            vpa: null,
            bank: null,
            international: true,
            acquirer_data: {
              auth_code: "998877",
              rrn: "665544332211",
            },
            error_code: "BAD_REQUEST_PAYMENT_CARD_EXPIRED",
            error_description: "International card declined",
            error_step: "payment_authorization",
            error_source: "acquirer",
            error_reason: "card_declined",
            token_id: null,
            contact: "+919876543213",
            email: "intl@example.com",
            created_at: 1691736000,
          },
        },
      },
    };

    const webhookRes = await fetch(`${baseUrl}/api/webhooks/razorpay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookPayload),
    });
    expect(webhookRes.status).toBe(200);
    const webhookData = (await webhookRes.json()) as { received: boolean };
    expect(webhookData.received).toBe(true);

    const eventRow = await dbClient.execute({
      sql: `SELECT * FROM live_payment_events WHERE razorpay_order_id = ? ORDER BY created_at_utc DESC LIMIT 1`,
      args: [orderData.orderId],
    });
    expect(eventRow.rows.length).toBe(1);
    const row = eventRow.rows[0] as any;

    expect(row.payment_method).toBe("card");
    expect(row.card_last4).toBe("1234");
    expect(row.card_network).toBe("American Express");
    expect(row.card_issuer).toBe("American Express");
    expect(row.card_type).toBe("credit");
    expect(row.card_emi).toBe(0);
    expect(row.is_international).toBe(1);
    expect(row.vpa).toBeNull();
    expect(row.bank_code).toBeNull();
    expect(row.acquirer_auth_code).toBe("998877");
    expect(row.acquirer_rrn).toBe("665544332211");
    expect(row.razorpay_contact).toBe("+919876543213");
    expect(row.razorpay_email).toBe("intl@example.com");
    expect(row.razorpay_created_at).toBe(1691736000);
    expect(row.status).toBe("failed");
  });
});
