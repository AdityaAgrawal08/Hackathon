import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app, dbClient } from "../../app/server.js";
import { runMigrations } from "../../packages/core/src/index.js";
import { simulateFailureTriage } from "../../app/recovery.js";

describe("Task 2.8: Delivery Receipt (DLR) Webhook Ingestion & Twilio Gather", () => {
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("ingests Brevo email delivery receipts and logs to audit ledger", async () => {
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

    const audit = await dbClient.execute(
      "SELECT * FROM audit_log WHERE entry_type='OUTCOME' ORDER BY rowid DESC LIMIT 1",
    );
    expect(audit.rows.length).toBe(1);
    expect(String(audit.rows[0]?.payload_json)).toContain("brevo");
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

  it("handles Twilio IVR gather (Press 1) and generates handoff TwiML response", async () => {
    const session = await simulateFailureTriage("SALARY_DELAY", baseUrl, dbClient);

    const res = await fetch(`${baseUrl}/api/webhooks/twilio/gather?proposalId=${session.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Digits: "1" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<Response>");
    expect(text).toContain("WhatsApp aur SMS par secure payment link");

    const audit = await dbClient.execute(
      "SELECT * FROM audit_log WHERE entry_type='ACTION' ORDER BY rowid DESC LIMIT 1",
    );
    expect(audit.rows.length).toBe(1);
    expect(String(audit.rows[0]?.payload_json)).toContain("PRESS_1_GATHER_HANDOFF");
  });
});
