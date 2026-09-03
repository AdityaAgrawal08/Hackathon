/**
 * Automated Tests for Phase 3 / Task 7.3 (BNK-18): Real-Time Bank Switch Health Circuit Breaker & Inter-Bank Steering
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import {
  BankCircuitBreakerManager,
  resolveBankFromIdentifier,
} from "../../packages/core/src/decide/bank_circuit_breaker.js";
import { app, dbClient } from "../../app/server.js";
import { runMigrations } from "../../packages/core/src/db/migrate.js";

describe("Phase 3 / Task 7.3 (BNK-18): Real-Time Bank Switch Health & Inter-Bank Steering", () => {
  let manager: BankCircuitBreakerManager;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await runMigrations(dbClient);
    server = app.listen(0);
    const addr = server.address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    manager = new BankCircuitBreakerManager();
  });

  describe("1. Bank Identifier Resolution", () => {
    it("resolves Top 4 Indian Issuer Banks from VPA handles accurately", () => {
      expect(resolveBankFromIdentifier("arjun@okhdfcbank")).toBe("HDFC");
      expect(resolveBankFromIdentifier("priya@oksbi")).toBe("SBI");
      expect(resolveBankFromIdentifier("vikram@okicici")).toBe("ICICI");
      expect(resolveBankFromIdentifier("rohit@okaxis")).toBe("AXIS");
    });

    it("resolves banks from IFSC codes and bank name tokens", () => {
      expect(resolveBankFromIdentifier("HDFC0000001")).toBe("HDFC");
      expect(resolveBankFromIdentifier("SBIN0001234")).toBe("SBI");
      expect(resolveBankFromIdentifier("ICIC0005678")).toBe("ICICI");
      expect(resolveBankFromIdentifier("UTIB0009999")).toBe("AXIS");
      expect(resolveBankFromIdentifier("user@gmail.com")).toBeNull();
      expect(resolveBankFromIdentifier("")).toBeNull();
    });
  });

  describe("2. Switch Health Evaluation & Time-of-Day Dynamics", () => {
    it("reports all 4 Top Indian Banks with valid health metrics and IFSC prefixes", () => {
      const banks = manager.getBankHealth();
      expect(banks.length).toBe(4);

      const hdfc = banks.find((b) => b.bankId === "HDFC");
      expect(hdfc).toBeDefined();
      expect(hdfc?.bankName).toBe("HDFC Bank");
      expect(hdfc?.ifscPrefix).toBe("HDFC");
      expect(hdfc?.successRate).toBeGreaterThan(0);
      expect(hdfc?.successRate).toBeLessThanOrEqual(1);
    });

    it("evaluates SBI nightly CBS maintenance dip during 02:00 IST window", () => {
      // 02:00 AM IST = 20:30 UTC previous day
      const nightUtcMs = Date.UTC(2026, 8, 2, 20, 30, 0);
      // 12:00 PM IST = 06:30 UTC
      const noonUtcMs = Date.UTC(2026, 8, 3, 6, 30, 0);

      const nightBanks = manager.getBankHealth(nightUtcMs);
      const noonBanks = manager.getBankHealth(noonUtcMs);

      const nightSbi = nightBanks.find((b) => b.bankId === "SBI");
      const noonSbi = noonBanks.find((b) => b.bankId === "SBI");

      expect(nightSbi?.successRate).toBeLessThan(noonSbi?.successRate ?? 1);
    });
  });

  describe("3. Circuit Breaker State & Inter-Bank Steering Recommendations", () => {
    it("permits standard retry when bank switch is healthy (CLOSED state)", () => {
      manager.setOverride("HDFC", { successRate: 0.94, circuitState: "CLOSED" });
      const rec = manager.evaluate("customer@okhdfcbank");

      expect(rec.allowed).toBe(true);
      expect(rec.circuitState).toBe("CLOSED");
      expect(rec.bannerWarning).toBe("");
    });

    it("trips circuit breaker (OPEN state) during critical outage and steers to healthy bank", () => {
      // Simulate HDFC core switch outage (35% success rate)
      manager.setOverride("HDFC", {
        successRate: 0.35,
        circuitState: "OPEN",
        status: "CRITICAL_OUTAGE",
      });
      // ICICI is healthy
      manager.setOverride("ICICI", {
        successRate: 0.98,
        circuitState: "CLOSED",
        status: "HEALTHY",
      });

      const rec = manager.evaluate("ananya@okhdfcbank", "upi");

      expect(rec.allowed).toBe(false); // Retrying HDFC is blocked
      expect(rec.circuitState).toBe("OPEN");
      expect(rec.impairedBank).toBe("HDFC");
      expect(rec.recommendedBank).toBe("ICICI");
      expect(rec.bannerWarning).toContain("HDFC Bank switch delays detected");
      expect(rec.bannerWarning).toContain("ICICI Bank UPI");
      expect(rec.steeringMessage).toContain("Payments routed through this bank are currently failing");
    });

    it("generates composite health snapshot with active outages count", () => {
      manager.setOverride("SBI", { circuitState: "OPEN", successRate: 0.42 });
      manager.setOverride("HDFC", { circuitState: "OPEN", successRate: 0.38 });

      const snapshot = manager.getCompositeSnapshot();
      expect(snapshot.activeOutagesCount).toBe(2);
      expect(snapshot.banks.length).toBe(4);
      expect(snapshot.overallRailHealth.rails.length).toBe(5);
    });
  });

  describe("4. REST API Integration Endpoints", () => {
    it("GET /api/rails/health returns composite rail and bank switch health", async () => {
      const res = await fetch(`${baseUrl}/api/rails/health`);
      expect(res.status).toBe(200);

      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.snapshot).toHaveProperty("overallRailHealth");
      expect(data.snapshot).toHaveProperty("banks");
      expect(data.snapshot.banks.length).toBe(4);
      expect(data.snapshot.overallRailHealth.rails.length).toBe(5);
    });

    it("POST /api/banks/circuit-breaker/evaluate evaluates incoming VPA identifier", async () => {
      const res = await fetch(`${baseUrl}/api/banks/circuit-breaker/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "rohit@okaxis",
          preferredMethod: "upi",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.evaluation).toHaveProperty("allowed");
      expect(data.evaluation).toHaveProperty("circuitState");
      expect(data.evaluation).toHaveProperty("recommendedBank");
    });
  });
});
