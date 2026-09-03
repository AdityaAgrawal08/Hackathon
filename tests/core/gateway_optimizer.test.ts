/**
 * Automated Tests for Phase 2 / Task 7.2 (OPT-17): Razorpay Optimizer Tier-0 In-Flight Gateway Cascade Engine
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import {
  GatewayOptimizer,
  isCascadeEligible,
  DEFAULT_CASCADE_SEQUENCE,
} from "../../packages/core/src/executor/gateway_optimizer.js";
import { app, dbClient } from "../../app/server.js";
import { runMigrations } from "../../packages/core/src/db/migrate.js";

describe("Phase 2 / Task 7.2 (OPT-17): Razorpay Optimizer Tier-0 In-Flight Gateway Cascade", () => {
  let optimizer: GatewayOptimizer;
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
    optimizer = new GatewayOptimizer();
  });

  describe("1. Acquirer Failure Classification (Technical vs Customer)", () => {
    it("identifies technical acquirer switch drops as cascade eligible", () => {
      expect(isCascadeEligible("GATEWAY_TIMEOUT")).toBe(true);
      expect(isCascadeEligible("ACQUIRER_TIMEOUT")).toBe(true);
      expect(isCascadeEligible("ISO_8583_91")).toBe(true);
      expect(isCascadeEligible("HTTP_504_GATEWAY_TIMEOUT")).toBe(true);
      expect(isCascadeEligible("504")).toBe(true);
      expect(isCascadeEligible("BANK_SWITCH_DOWN")).toBe(true);
    });

    it("identifies consumer-side declines as ineligible for in-flight cascading", () => {
      expect(isCascadeEligible("INSUFFICIENT_FUNDS")).toBe(false);
      expect(isCascadeEligible("CARD_EXPIRED")).toBe(false);
      expect(isCascadeEligible("INVALID_CVV")).toBe(false);
      expect(isCascadeEligible("USER_CANCELLED")).toBe(false);
      expect(isCascadeEligible("OTP_EXPIRED")).toBe(false);
      expect(isCascadeEligible("")).toBe(false);
    });
  });

  describe("2. In-Flight Multi-Gateway Cascading Execution", () => {
    it("auto-cascades in-flight from primary (HDFC) to secondary (Axis) and captures payment", () => {
      const result = optimizer.executeCascade({
        orderId: "order_cascade_test_01",
        amountPaise: 499900,
        initialErrorCode: "GATEWAY_TIMEOUT",
        idempotencyKey: "idem_opt_001",
      });

      expect(result.recoveredInFlight).toBe(true);
      expect(result.finalStatus).toBe("CAPTURED");
      expect(result.winningGateway).toBe("AXIS_PG");
      expect(result.cogsSavedPaise).toBe(63); // 18p SMS + 45p WhatsApp avoided
      expect(result.hops.length).toBe(2);
      expect(result.hops[0]?.gatewayId).toBe("HDFC_SMARTGATEWAY");
      expect(result.hops[0]?.status).toBe("FAILED");
      expect(result.hops[1]?.gatewayId).toBe("AXIS_PG");
      expect(result.hops[1]?.status).toBe("SUCCESS");
      expect(result.totalLatencyMs).toBeLessThan(2000); // Sub-2s SLA
    });

    it("bypasses cascade and immediately hands off customer-side declines to dunning", () => {
      const result = optimizer.executeCascade({
        orderId: "order_cascade_test_02",
        amountPaise: 199900,
        initialErrorCode: "INSUFFICIENT_FUNDS",
        idempotencyKey: "idem_opt_002",
      });

      expect(result.recoveredInFlight).toBe(false);
      expect(result.finalStatus).toBe("HANDOFF_TO_DUNNING");
      expect(result.winningGateway).toBeUndefined();
      expect(result.cogsSavedPaise).toBe(0);
      expect(result.hops.length).toBe(1);
      expect(result.reason).toContain("consumer-side decline");
    });

    it("exhausts all acquirers and hands off to ARBITER dunning when all gateways fail", () => {
      const result = optimizer.executeCascade({
        orderId: "order_cascade_test_03",
        amountPaise: 899900,
        initialErrorCode: "GATEWAY_TIMEOUT",
        idempotencyKey: "idem_opt_003",
        mockGatewayOutcomes: {
          AXIS_PG: { success: false, errorCode: "ACQUIRER_DOWN" },
          ICICI_PAYSEAL: { success: false, errorCode: "SWITCH_TIMEOUT" },
        },
      });

      expect(result.recoveredInFlight).toBe(false);
      expect(result.finalStatus).toBe("HANDOFF_TO_DUNNING");
      expect(result.hops.length).toBe(3);
      expect(result.hops.every((h) => h.status === "FAILED")).toBe(true);
      expect(result.reason).toContain("In-flight recovery exhausted");
    });
  });

  describe("3. Telemetry Metrics & Working Capital Tracking", () => {
    it("accurately tracks in-flight recoveries and COGS savings", () => {
      // 1 success, 1 customer decline, 1 exhausted
      optimizer.executeCascade({
        orderId: "order_m1",
        amountPaise: 300000,
        initialErrorCode: "GATEWAY_TIMEOUT",
        idempotencyKey: "idem_m1",
      });
      optimizer.executeCascade({
        orderId: "order_m2",
        amountPaise: 200000,
        initialErrorCode: "INSUFFICIENT_FUNDS",
        idempotencyKey: "idem_m2",
      });
      optimizer.executeCascade({
        orderId: "order_m3",
        amountPaise: 500000,
        initialErrorCode: "GATEWAY_TIMEOUT",
        idempotencyKey: "idem_m3",
        mockGatewayOutcomes: {
          AXIS_PG: { success: false },
          ICICI_PAYSEAL: { success: false },
        },
      });

      const metrics = optimizer.getMetrics();
      expect(metrics.totalRouted).toBe(3);
      expect(metrics.inFlightRecovered).toBe(1);
      expect(metrics.handoffToDunning).toBe(2);
      expect(metrics.recoveryRatePct).toBeCloseTo(33.3, 0);
      expect(metrics.totalCogsSavedPaise).toBe(63);
      expect(metrics.totalCogsSavedFormatted).toBe("₹0.63");
      expect(metrics.averageLatencyMs).toBeGreaterThan(0);
    });
  });

  describe("4. End-to-End REST API Endpoints", () => {
    it("POST /api/optimizer/route executes in-flight cascade simulation", async () => {
      const res = await fetch(`${baseUrl}/api/optimizer/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "order_api_test_01",
          amountPaise: 499900,
          errorCode: "GATEWAY_TIMEOUT",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.result.recoveredInFlight).toBe(true);
      expect(data.result.winningGateway).toBe("AXIS_PG");
    });

    it("GET /api/optimizer/metrics returns aggregate gateway telemetry", async () => {
      const res = await fetch(`${baseUrl}/api/optimizer/metrics`);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.metrics).toHaveProperty("totalRouted");
      expect(data.metrics).toHaveProperty("inFlightRecovered");
      expect(data.metrics).toHaveProperty("totalCogsSavedPaise");
    });

    it("POST /api/payments/failed?optimizer=true intercepts technical errors in-flight", async () => {
      const res = await fetch(`${baseUrl}/api/payments/failed?optimizer=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          razorpay_order_id: `order_failed_opt_${Date.now()}`,
          razorpay_payment_id: `pay_failed_opt_${Date.now()}`,
          error_code: "GATEWAY_TIMEOUT",
          amountPaise: 399900,
          productName: "Optimizer Test Subscription",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.inFlightRecovered).toBe(true);
      expect(data.status).toBe("CAPTURED");
      expect(data.winningGateway).toBe("AXIS_PG");
    });
  });
});
