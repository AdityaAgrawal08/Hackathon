/**
 * Automated Tests for Live Dashboard Telemetry & 4-Arm CFO Benchmark APIs (Phase 6)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "http";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const { app } = await import("../../app/server.js");
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("Phase 6 / Task 6.2: Live Dashboard Telemetry & CFO Benchmark APIs", () => {
  it("GET /api/benchmark/four-way executes benchmark with query parameters", async () => {
    const res = await fetch(`${baseUrl}/api/benchmark/four-way?size=300&seed=c0de&domain=b2b`);
    expect(res.status).toBe(200);

    const data = await res.json() as any;
    expect(data.batchSize).toBe(300);
    expect(data.seed).toBe("0xC0DE");
    expect(data.domain).toBe("b2b");
    expect(data.arms.control).toBeDefined();
    expect(data.arms.blindRetries).toBeDefined();
    expect(data.arms.staticRules).toBeDefined();
    expect(data.arms.arbiter).toBeDefined();
    expect(data.arms.arbiter.recoveryRatePercent).toBeGreaterThan(data.arms.staticRules.recoveryRatePercent);
    expect(data.liftVsControlPaise).toBeGreaterThan(0);
  });

  it("POST /api/benchmark/four-way/run supports custom options body with COGS overrides", async () => {
    const res = await fetch(`${baseUrl}/api/benchmark/four-way/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchSize: 200,
        seed: 0x42,
        domain: "saas",
        channelCogs: {
          gatewayRetryPaise: 20,
          smsPaise: 15,
          emailPaise: 5,
        },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(data.report.batchSize).toBe(200);
    expect(data.report.domain).toBe("saas");
    expect(data.report.arms.blindRetries.totalCostPaise).toBe(200 * 3 * 20);
    expect(data.report.arms.staticRules.totalCostPaise).toBe(200 * (15 + 5));
  });

  it("GET /api/customers/profiles returns longitudinal customer behavioral intelligence records", async () => {
    const res = await fetch(`${baseUrl}/api/customers/profiles?limit=10`);
    expect(res.status).toBe(200);

    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(Array.isArray(data.profiles)).toBe(true);
    if (data.profiles.length > 0) {
      const p = data.profiles[0];
      expect(p.id).toBeDefined();
      expect("preferred_channel" in p).toBe(true);
      expect("total_recovered_paise" in p).toBe(true);
    }
  });

  it("GET /api/decide/priority-queue returns prioritized queue with batch sequencing", async () => {
    const res = await fetch(`${baseUrl}/api/decide/priority-queue`);
    expect(res.status).toBe(200);

    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(data.queue).toBeDefined();
    expect(Array.isArray(data.queue.candidates)).toBe(true);
    expect(Array.isArray(data.queue.microBatches)).toBe(true);
    expect(data.queue.quietHoursActive !== undefined).toBe(true);
  });

  it("POST /api/decide/batch-sequence accepts candidate batch and returns tiered sequence", async () => {
    const candidates = [
      {
        id: "cand_fast_opener",
        amountPaise: 500000,
        preferredChannel: "EMAIL",
        emailOpenLatencyMins: 2.5,
        historicalOpenRate: 0.95,
        domainType: "D2C_ECOMMERCE",
      },
      {
        id: "cand_slow_opener",
        amountPaise: 500000,
        preferredChannel: "EMAIL",
        emailOpenLatencyMins: 600,
        historicalOpenRate: 0.1,
        domainType: "D2C_ECOMMERCE",
      },
    ];

    const res = await fetch(`${baseUrl}/api/decide/batch-sequence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidates }),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(data.result.candidates.length).toBe(2);
    // Fast opener must be prioritized first
    expect(data.result.candidates[0].id).toBe("cand_fast_opener");
    expect(data.result.candidates[0].priorityTier).toBe("TIER_1_CRITICAL");
    expect(data.result.candidates[0].priorityScore).toBeGreaterThan(data.result.candidates[1].priorityScore);
  });

  it("GET /dashboard serves modernized HTML with behavioral memory tab and zero payday/whatsapp assumptions", async () => {
    const res = await fetch(`${baseUrl}/dashboard`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("tab-behavioral-memory");
    expect(html).toContain("ARBITER Behavioral Intelligence & Dynamic Priority Engine");
    expect(html).toContain("Longitudinal Customer Memory & Intelligent Queue");
    expect(html).toContain("bm-hero-profiles-count");
    expect(html).toContain("priority-queue-body");
    expect(html).toContain("customer-profiles-body");

    // Invariant: Zero Payday / Salary assumptions
    expect(html).not.toContain("06:30 AM Salary Scheduler");
    expect(html).not.toContain("Salary Slot");

    // Invariant: Behavioral intelligence bar is primary
    expect(html).toContain("ARBITER Behavioral Intelligence & Dynamic Priority Engine");
  });
});
