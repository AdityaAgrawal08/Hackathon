import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app, dbClient } from "../../app/server.js";

describe("Provider DLR Webhook Ingestion & Twilio Gather", () => {
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

  it("ingests Brevo email delivery receipts", async () => {
    const res = await fetch(`${baseUrl}/api/webhooks/providers/brevo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "delivered",
        email: "rahul@example.com",
        "message-id": "<msg_brevo_test_123@smtp-relay.mailin.fr>",
        date: "2026-08-29T16:00:00.000Z",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.received).toBe(true);
  });

  it("ingests MSG91 SMS delivery receipts", async () => {
    const res = await fetch(`${baseUrl}/api/webhooks/providers/msg91`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req_msg91_test_456",
        status: "DELIVERED",
        mobile: "919876543210",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.received).toBe(true);
  });

  it("ingests Gupshup WhatsApp delivery receipts", async () => {
    const res = await fetch(`${baseUrl}/api/webhooks/providers/gupshup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "message-event",
        payload: {
          id: "wa_msg_789",
          type: "read",
          destination: "919811122334",
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.received).toBe(true);
  });

  it("handles Twilio IVR gather (Press 1) and returns TwiML", async () => {
    const res = await fetch(`${baseUrl}/api/webhooks/twilio/gather?proposalId=test_prop_123`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Digits: "1" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<Response>");
    expect(text).toContain("payment link");
  });

  it("handles Twilio IVR gather with no input (hangup)", async () => {
    const res = await fetch(`${baseUrl}/api/webhooks/twilio/gather?proposalId=test_prop_456`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Digits: "2" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<Hangup/>");
  });
});
