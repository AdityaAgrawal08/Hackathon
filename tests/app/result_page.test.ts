import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app, dbClient } from "../../app/server.js";
import { simulateFailureTriage, completeRecovery } from "../../app/recovery.js";

describe("Phase 4: Result Page & Post-Payment Experience Integration Tests", () => {
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

  it("Task 4.1: serves the result portal at /result", async () => {
    const res = await fetch(`${baseUrl}/result?tok=${activeSession.recoveryToken}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Payment Status & Receipt");
    expect(html).toContain("cardSuccess");
    expect(html).toContain("cardPending");
  });

  it("Task 4.2 & 4.8: returns recovery result details with verbatim messages via REST API", async () => {
    const res = await fetch(`${baseUrl}/api/recovery/result/${activeSession.id}`);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.proposalId).toBe(activeSession.id);
    expect(data.customerName).toBe("Rahul Sharma");
    expect(data.amountPaise).toBe(199900);
    expect(data.formattedAmount).toBe("₹1,999.00");
    expect(data.currency).toBe("INR");
    expect(data.isSettled).toBe(false);
    expect(data.status).toBe("PENDING_RECOVERY");

    // Task 4.2: Verbatim Dispatched Message Verification
    expect(data.messages).toBeDefined();
    expect(data.messages.smsEn).not.toBeNull();
    expect(data.messages.smsEn.templateId).toBe("1407168923450011");
    expect(data.messages.smsEn.dltRegistered).toBe(true);
    expect(data.messages.smsEn.content).toContain("₹1,999.00");
    expect(data.messages.smsEn.content).toContain("ARBITER");

    expect(data.messages.emailEn).not.toBeNull();
    expect(data.messages.emailEn.content).toContain("Rahul Sharma");
    expect(data.messages.emailEn.content).toContain("₹1,999.00");

    expect(data.messages.voiceHi).not.toBeNull();
    expect(data.messages.voiceHi.content).toContain("Rahul Sharma");
  });

  it("Task 4.3: transitions result status to SETTLED_RECOVERED upon payment completion", async () => {
    // Settle proposal
    await completeRecovery(activeSession.id, dbClient);

    const res = await fetch(`${baseUrl}/api/recovery/result/${activeSession.id}`);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.isSettled).toBe(true);
    expect(data.status).toBe("SETTLED_RECOVERED");
    expect(data.paymentId).toMatch(/^pay_rec_/);
    expect(data.settledAtUtc).toBeDefined();
  });
});
