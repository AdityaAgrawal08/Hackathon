/**
 * Automated Verification Suite for Phase 3: Web & API Domain Context Endpoints
 * Verifies D2C 1-Tap UPI, SaaS grace period, B2B early settlement, High-Ticket split-pay,
 * and Intelligent Priority Batch Sequencer over HTTP.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app, dbClient } from "../../app/server.js";
import { runMigrations } from "../../packages/core/src/db/migrate.js";

describe("Phase 3: Web & API Domain Context Endpoints", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await runMigrations(dbClient);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as any;
        baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  describe("1. POST /api/domain/d2c/upi-intent", () => {
    it("returns verified 1-Tap UPI Intent URI and reservation badge", async () => {
      const res = await fetch(`${baseUrl}/api/domain/d2c/upi-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchantVpa: "urbanstore@razorpay",
          merchantName: "Urban Store",
          transactionRef: "tx_d2c_123",
          amountPaise: 199900,
          cartReservationMins: 25,
          concessionDiscountBp: 500, // 5% off
          productName: "AirPods Case",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.strategy.domain).toBe("D2C_ECOMMERCE");
      expect(data.strategy.originalAmountPaise).toBe(199900);
      expect(data.strategy.discountPaise).toBe(9995); // 5% of 199900
      expect(data.strategy.netPayablePaise).toBe(189905);
      expect(data.strategy.upiIntentUri).toContain("upi://pay");
      expect(data.strategy.upiIntentUri).toContain("urbanstore%40razorpay");
      expect(data.strategy.badgeText).toContain("Cart reserved for 25 mins");
    });

    it("rejects invalid or missing amount with 400", async () => {
      const res = await fetch(`${baseUrl}/api/domain/d2c/upi-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountPaise: -500,
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Valid amountPaise is required");
    });
  });

  describe("2. POST /api/domain/saas/grace-period", () => {
    it("returns pre-debit notice when retries remain", async () => {
      const res = await fetch(`${baseUrl}/api/domain/saas/grace-period`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mandateId: "man_saas_001",
          planName: "Monthly Basic",
          amountPaise: 99900,
          retryCount: 1,
          maxRetries: 3,
          softLockGraceDays: 4,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.strategy.domain).toBe("SAAS_MANDATES");
      expect(data.strategy.isSoftLocked).toBe(false);
      expect(data.strategy.strategyAction).toBe("PRE_DEBIT_NOTIFICATION");
      expect(data.strategy.customerMessage).toContain("RBI Advance Notice");
    });

    it("returns soft-lock grace notice when retries are exhausted", async () => {
      const res = await fetch(`${baseUrl}/api/domain/saas/grace-period`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mandateId: "man_saas_002",
          planName: "Pro Tier",
          amountPaise: 299900,
          retryCount: 3,
          maxRetries: 3,
          softLockGraceDays: 5,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.strategy.isSoftLocked).toBe(true);
      expect(data.strategy.strategyAction).toBe("SOFT_LOCK_GRACE_NOTICE");
      expect(data.strategy.customerMessage).toContain("5-day grace period");
    });

    it("rejects missing mandateId with 400", async () => {
      const res = await fetch(`${baseUrl}/api/domain/saas/grace-period`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountPaise: 99900,
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("3. POST /api/domain/b2b/early-settlement", () => {
    it("computes 2/10 Net 30 terms and returns virtual VPA", async () => {
      const res = await fetch(`${baseUrl}/api/domain/b2b/early-settlement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoiceNumber: "INV-2026-991",
          clientCompany: "Tata Sky Logistics",
          amountPaise: 20000000, // ₹2,00,000.00
          discountPercent: 2.0,
          annualCostOfCapital: 0.14,
          dsoDaysSaved: 20,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.strategy.domain).toBe("B2B_INVOICES");
      expect(data.strategy.discountPaise).toBe(400000); // 2% = ₹4,000
      expect(data.strategy.discountedAmountPaise).toBe(19600000); // ₹1,96,000
      expect(data.strategy.workingCapitalSavedPaise).toBe(153425); // ₹1,534.25
      expect(data.strategy.smartCollectVpa).toContain("smartcollect.b2b.inv2026991@razorpay");
      expect(data.strategy.formalEmailBody).toContain("Tata Sky Logistics");
    });

    it("rejects missing clientCompany with 400", async () => {
      const res = await fetch(`${baseUrl}/api/domain/b2b/early-settlement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountPaise: 1000000,
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("4. POST /api/domain/edtech/split-pay", () => {
    it("returns 3x split installments with sum strictly preserved", async () => {
      const res = await fetch(`${baseUrl}/api/domain/edtech/split-pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          totalAmountPaise: 4500000, // ₹45,000.00
          customerName: "Vikram Malhotra",
          productName: "Full Stack AI Fellowship",
          installmentCount: 3,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.strategy.domain).toBe("HIGH_TICKET");
      expect(data.strategy.isSumPreserved).toBe(true);
      expect(data.strategy.installments.length).toBe(3);
      expect(data.strategy.installments[0].amountPaise).toBe(1500000);
      expect(data.strategy.installments[1].amountPaise).toBe(1500000);
      expect(data.strategy.installments[2].amountPaise).toBe(1500000);
      expect(data.strategy.headline).toContain("3x No-Cost Monthly Installments");
    });
  });

  describe("5. POST /api/decide/batch-sequence", () => {
    it("sequences a batch with velocity prioritization and micro-batches", async () => {
      const daytimeMs = new Date("2026-09-04T08:30:00.000Z").getTime();
      const res = await fetch(`${baseUrl}/api/decide/batch-sequence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidates: [
            { id: "c1_slow", amountPaise: 200000, emailOpenLatencyMins: 400, domainType: "D2C_ECOMMERCE" },
            { id: "c2_fast", amountPaise: 200000, emailOpenLatencyMins: 5, domainType: "D2C_ECOMMERCE" },
            { id: "c3_bounced", amountPaise: 500000, engagementStatus: "HARD_BOUNCED" },
          ],
          config: {
            respectQuietHours: false,
            maxDispatchesPerBatch: 1,
            pacingIntervalMs: 1000,
          },
          nowMs: daytimeMs,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.result.totalInputCount).toBe(3);
      expect(data.result.eligibleCount).toBe(2);
      expect(data.result.suppressedCount).toBe(1);

      // Fast opener should be first
      expect(data.result.candidates[0].id).toBe("c2_fast");
      expect(data.result.candidates[0].priorityTier).toBe("TIER_1_CRITICAL");

      // 2 micro-batches of 1 each
      expect(data.result.microBatches.length).toBe(2);
    });

    it("rejects non-array candidates with 400", async () => {
      const res = await fetch(`${baseUrl}/api/decide/batch-sequence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidates: "invalid",
        }),
      });

      expect(res.status).toBe(400);
    });
  });
});
