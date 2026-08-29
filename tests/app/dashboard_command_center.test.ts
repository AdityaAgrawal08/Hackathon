import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app, dbClient } from "../../app/server.js";

describe("Phase 5: Merchant Recovery Command Center Dashboard Integration Tests", () => {
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

  it("Task 5.1: serves the merchant recovery dashboard at /dashboard", async () => {
    const res = await fetch(`${baseUrl}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();

    expect(html).toContain("ARBITER");
    expect(html).toContain("AI Revenue Recovery Command Center");
    expect(html).toContain("SALARY_DELAY");
    expect(html).toContain("CARD_EXPIRED");
    expect(html).toContain("BANK_OUTAGE");
    expect(html).toContain("UPI_TIMEOUT");
    expect(html).toContain("BOT_RISK");
    expect(html).toContain("slider-autonomy");
    expect(html).toContain("TRAI Regulatory Filter");
  });

  it("Task 5.2: executes live AI failure diagnosis and EV ranking via POST /api/recovery/triage", async () => {
    const DAYTIME_MS = Date.parse("2026-08-28T05:30:00.000Z");
    const res = await fetch(`${baseUrl}/api/recovery/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "SALARY_DELAY", simulatedTimeMs: DAYTIME_MS }),
    });

    expect(res.status).toBe(200);
    const session = await res.json();

    expect(session.id).toMatch(/^prop_/);
    expect(session.customerName).toBe("Rahul Sharma");
    expect(session.amountPaise).toBe(199900);
    expect(session.diagnosis.rootCause).toBe("INSUFFICIENT_FUNDS");
    expect(session.features.values.length).toBe(16);
    expect(session.probability).toBeGreaterThan(0);
    expect(session.decideOutput.chosen.action).toBeDefined();
    expect(session.autonomyStatus).toBe("AUTO_APPROVED");
  });

  it("Task 5.4: respects dynamic autonomy envelope slider thresholds", async () => {
    const DAYTIME_MS = Date.parse("2026-08-28T05:30:00.000Z");
    // 1. High value ₹4,999 with default ₹2,000 threshold -> AWAITING_APPROVAL
    const res1 = await fetch(`${baseUrl}/api/recovery/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "CARD_EXPIRED", autonomyThresholdPaise: 200000, simulatedTimeMs: DAYTIME_MS }),
    });
    const session1 = await res1.json();
    expect(session1.autonomyStatus).toBe("AWAITING_APPROVAL");

    // 2. Approve proposal
    const approveRes = await fetch(`${baseUrl}/api/recovery/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposalId: session1.id }),
    });
    const approveData = await approveRes.json();
    expect(approveData.success).toBe(true);

    // 3. Same high value with ₹6,000 threshold dial -> AUTO_APPROVED
    const res2 = await fetch(`${baseUrl}/api/recovery/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customPreset: {
          customerName: "Sneha Gupta",
          amountPaise: 450000,
          failureCode: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
        },
        autonomyThresholdPaise: 600000,
        simulatedTimeMs: DAYTIME_MS,
      }),
    });
    const session2 = await res2.json();
    expect(session2.autonomyStatus).toBe("AUTO_APPROVED");
  });


  it("Task 5.5: returns 100-event Monte Carlo batch comparison proof ('The Bar')", async () => {
    const res = await fetch(`${baseUrl}/api/recovery/batch-proof`);
    expect(res.status).toBe(200);
    const benchmark = await res.json();

    expect(benchmark.naive).toBeDefined();
    expect(benchmark.arbiter).toBeDefined();
    expect(benchmark.delta).toBeDefined();

    expect(benchmark.arbiter.recoveredRevenuePaise).toBeGreaterThan(benchmark.naive.recoveredRevenuePaise);
    expect(benchmark.delta.wastedRetriesSaved).toBeGreaterThan(0);
  });
});
