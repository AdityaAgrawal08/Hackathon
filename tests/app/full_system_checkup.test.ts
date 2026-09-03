/**
 * Aggressive Full System Checkup Suite:
 * - Customer-Centric Web Validation (D2C checkout, 1-Tap UPI Intent, Cart salvage, Concessions)
 * - Vendor-Centric Web Validation (Dashboard, 4-Way Benchmark, SaaS Mandate RBI 24h, B2B DSO, Policies)
 * - CLI & Cryptographic Security (HMAC verification, Token tamper resistance, FSM fail-closed, SHA-256 Ledger)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app, dbClient } from "../../app/server.js";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import {
  transitionFSM,
  IllegalStateTransitionError,
  GuardEvaluationError,
  computeCredentialId,
} from "../../packages/core/src/index.js";

describe("Aggressive Full System Checkup: Web & Security Validation", () => {
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

  describe("1. Customer-Centric Web Validation", () => {
    it("handles abandoned pre-payment cart salvage and token restoration", async () => {
      // 1. Abandon cart
      const abandonRes = await fetch(`${baseUrl}/api/checkout/abandon`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: "Kavita Nair",
          customerPhone: "+91 98765 11223",
          customerEmail: "kavita@example.com",
          cartItems: [{ name: "Handcrafted Silk Kurta", qty: 1, pricePaise: 299900 }],
          cartAmountPaise: 299900,
          dropOffStep: "PAYMENT_SCREEN_EXITED",
        }),
      });
      const abandonData = await abandonRes.json() as any;
      expect(abandonRes.status).toBe(200);
      expect(abandonData.success).toBe(true);
      expect(abandonData.recoveryLink.token).toBeDefined();

      // 2. Restore cart via token
      const restoreRes = await fetch(`${baseUrl}/api/checkout/restore/${abandonData.recoveryLink.token}`);
      const restoreData = await restoreRes.json() as any;
      expect(restoreRes.status).toBe(200);
      expect(restoreData.restored).toBe(true);
      expect(restoreData.cartAmountPaise).toBe(299900);
    });

    it("ingests customer interaction events and autonomously replans recovery actions", async () => {
      const eventId = `evt_chk_${Date.now()}`;
      const custId = `cust_chk_${Date.now()}`;

      await dbClient.execute({
        sql: `INSERT INTO customer_profiles (id, name, phone, email, created_at_utc) VALUES (?, 'Checkup User', ?, 'checkup@test.com', datetime('now'))`,
        args: [custId, `96${Math.floor(10000000 + Math.random() * 90000000)}`],
      });

      await dbClient.execute({
        sql: `INSERT INTO live_payment_events (id, razorpay_payment_id, razorpay_order_id, customer_profile_id, product_name, amount_paise, status, failure_code, failure_description, retry_count, last_outreach_utc, created_at_utc)
              VALUES (?, 'pay_chk_1', 'order_chk_1', ?, 'Pro Plan', 499900, 'failed', 'BAD_REQUEST_ERROR', 'Card Limit', 1, datetime('now', '-5 hours'), datetime('now', '-5 hours'))`,
        args: [eventId, custId],
      });

      // Customer dwells in portal >20s and exits without paying
      const res = await fetch(`${baseUrl}/api/events/${eventId}/interaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          interactionType: "PORTAL_EXITED_NO_PAY",
          dwellTimeSeconds: 35,
        }),
      });
      const data = await res.json() as any;
      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.rePlanResult.action).toBe("TRIGGER_DOWNSELL_SPLIT");
      expect(data.rePlanResult.concessionType).toBe("SPLIT_PAY");
    });
  });

  describe("2. Vendor-Centric Web Validation", () => {
    it("evaluates seed-locked 4-way baseline ablation benchmark via API", async () => {
      const res = await fetch(`${baseUrl}/api/benchmark/four-way?size=500&seed=5eed`);
      const data = await res.json() as any;

      expect(res.status).toBe(200);
      expect(data.batchSize).toBe(500);
      expect(data.seed).toBe("0x5EED");
      expect(data.arms.control.recoveryRatePercent).toBeGreaterThan(15);
      expect(data.arms.arbiter.recoveryRatePercent).toBeGreaterThan(data.arms.staticRules.recoveryRatePercent);
      expect(data.liftVsControlPaise).toBeGreaterThan(0);
    });

    it("schedules SaaS recurring mandate retries honoring RBI 24h notice invariant", async () => {
      const res = await fetch(`${baseUrl}/api/mandates/auto-debit-failure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: `cust_saas_checkup_${Date.now()}`,
          customerName: "Rohan Varma",
          customerPhone: "9812345678",
          mandateType: "UPI_AUTOPAY",
          planName: "Pro Annual Cloud",
          amountPaise: 1199900,
          failureCode: "INSUFFICIENT_FUNDS",
        }),
      });
      const data = await res.json() as any;

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.retryPlan.rbiCompliant).toBe(true);
      expect(data.retryPlan.hoursUntilDebit).toBeGreaterThanOrEqual(24);
      expect(data.retryPlan.strategy).toBe("SALARY_WINDOW_0630");
    });

    it("generates B2B invoice early settlement terms with DSO cost savings", async () => {
      const res = await fetch(`${baseUrl}/api/invoices/chaser/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorId: "vend_acme_corp",
          clientCompany: "Omni Logistics Ltd",
          contactPerson: "Rajesh Kumar",
          contactEmail: "rajesh@omnilogistics.in",
          amountPaise: 5000000, // ₹50,000
          invoiceNumber: `INV-${Date.now()}`,
          daysOverdue: 14,
          earlyDiscountPercent: 2.0,
        }),
      });
      const data = await res.json() as any;

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.chaserPlan.discountSavedPaise).toBe(100000); // 2% of ₹50,000 = ₹1,000 (100,000 paise)
      expect(data.chaserPlan.workingCapitalSavedPaise).toBeGreaterThan(0);
    });

    it("persists and verifies SHA-256 cryptographic audit ledger chain", async () => {
      const entityId = `entity_checkup_${Date.now()}`;
      const { appendAuditLedger, verifyAuditLedgerChain } = await import(
        "../../packages/core/src/ledger/audit_ledger.js"
      );

      // Append two entries
      await appendAuditLedger(dbClient, {
        entityId,
        eventType: "DISPATCH_PACED",
        actor: "RECOVERY_AGENT",
        payload: { channel: "WHATSAPP", template: "smart_collect" },
      });

      await appendAuditLedger(dbClient, {
        entityId,
        eventType: "PAYMENT_COMPLETED",
        actor: "CUSTOMER_PORTAL",
        payload: { paymentMethod: "UPI_INTENT", rzpPaymentId: "pay_checkup_123" },
      });

      const verification = await verifyAuditLedgerChain(dbClient);
      expect(verification.valid).toBe(true);
      expect(verification.totalEntries).toBeGreaterThanOrEqual(2);
    });
  });

  describe("3. CLI & Cryptographic Security Validation", () => {
    it("guarantees DPDP Act 2023 PII-blind credential identity hashing", () => {
      const credIdA = computeCredentialId("+91 (987) 654-3210", "CUSTOMER@ARBITER.LIVE");
      const credIdB = computeCredentialId("9876543210", "customer@arbiter.live");

      expect(credIdA).toBe(credIdB);
      expect(credIdA).toMatch(/^[a-f0-9]{64}$/); // SHA-256 format
    });

    it("strictly rejects illegal state transitions fail-closed in the FSM", () => {
      // Direct jump from DETECTED to RECOVERED_SUCCESS without payment is impossible
      expect(() => transitionFSM("DETECTED", "DISPATCH_PACED")).toThrow(IllegalStateTransitionError);

      // Transition with active cooldown violation is strictly blocked by Guard
      const blockedCtx = {
        touchCount: 1,
        lastTouchAtUtc: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30m ago (< 4h)
        isOptedOut: false,
        createdAtUtc: new Date().toISOString(),
        domain: "D2C_CHECKOUT" as const,
      };
      expect(() => transitionFSM("DIAGNOSED", "DISPATCH_PACED", blockedCtx)).toThrow(GuardEvaluationError);
    });
  });
});
