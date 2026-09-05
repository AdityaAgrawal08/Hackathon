/**
 * Tests for /api/compliance/opt-out and expanded /api/vendor/analytics endpoints
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app } from "../../app/server.js";

describe("Compliance Opt-Out & Expanded Telemetry Endpoints", () => {
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

  it("POST /api/compliance/opt-out successfully registers SMS STOP / Unsubscribe", async () => {
    const res = await fetch(`${baseUrl}/api/compliance/opt-out`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: "919876543210",
        reason: "Customer replied STOP to SMS",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("opted_out");
    expect(data.phone).toBe("919876543210");
    expect(data.timestampUtc).toBeDefined();
  });

  it("GET /api/vendor/analytics returns TTR, Net ROI, Fatigue, and Circuit Breaker telemetry", async () => {
    const res = await fetch(`${baseUrl}/api/vendor/analytics`, {
      headers: { "x-admin-key": process.env.ADMIN_KEY || "dev-admin-key" },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ttrSecondsAverage).toBeDefined();
    expect(data.formattedTtr).toMatch(/\d+m \d+s/);
    expect(data.netRoiRatio).toBeDefined();
    expect(data.formattedRoi).toContain("ROI");
    expect(data.fatigueSuppressedCount).toBeDefined();
    expect(data.circuitBreakerStatus).toBeDefined();
    expect(data.banditState).toBeDefined();
  });

  it("POST /api/agent/unified-loop/plan generates domain-specific recovery plan", async () => {
    const res = await fetch(`${baseUrl}/api/agent/unified-loop/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain: "ECOMMERCE",
        referenceId: "test_ref_001",
        customerId: "cust_test_001",
        customerName: "Priya Sharma",
        phone: "919876543299",
        amountPaise: 399900,
        failureCode: "payment_failed",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.domain).toBe("ECOMMERCE");
    expect(data.recommendedAction).toBeDefined();
    expect(data.expectedRecoveryRate).toBeGreaterThan(0);
  });

  it("GET /api/agent/circuit-breaker returns rail health status", async () => {
    const res = await fetch(`${baseUrl}/api/agent/circuit-breaker`, {
      headers: { "x-admin-key": process.env.ADMIN_KEY || "dev-admin-key" },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("active");
    expect(data.rails).toBeDefined();
  });
});
