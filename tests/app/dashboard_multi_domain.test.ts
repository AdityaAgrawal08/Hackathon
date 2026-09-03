/**
 * Automated Tests for Phase 4 / Task 7.4 (UI-19): Multi-Domain Executive Command Cockpit in Vendor Dashboard
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app, dbClient } from "../../app/server.js";
import { runMigrations } from "../../packages/core/src/db/migrate.js";

describe("Phase 4 / Task 7.4 (UI-19): Multi-Domain Executive Command Cockpit", () => {
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

  describe("1. Dashboard HTML Multi-Domain Rendering & Navigation Structure", () => {
    it("renders GET /dashboard with 200 OK and contains all 5 multi-domain navigation tabs", async () => {
      const res = await fetch(`${baseUrl}/dashboard`);
      expect(res.status).toBe(200);

      const html = await res.text();
      expect(html).toContain('id="tab-transactions"');
      expect(html).toContain('id="tab-mandates"');
      expect(html).toContain('id="tab-invoices"');
      expect(html).toContain('id="tab-bank-matrix"');
      expect(html).toContain('id="tab-recovery-report"');
    });

    it("contains all 5 dedicated domain cockpit panels with exact regulatory proofs", async () => {
      const res = await fetch(`${baseUrl}/dashboard`);
      const html = await res.text();

      // Check panel IDs
      expect(html).toContain('id="panel-transactions"');
      expect(html).toContain('id="panel-mandates"');
      expect(html).toContain('id="panel-invoices"');
      expect(html).toContain('id="panel-bank-matrix"');
      expect(html).toContain('id="panel-recovery-report"');

      // SaaS Mandates proofs
      expect(html).toContain("06:30 AM IST");
      expect(html).toContain("RBI 24h Notice Proof");
      expect(html).toContain("UPI Autopay");

      // B2B Invoices proofs
      expect(html).toContain("Days Sales Outstanding");
      expect(html).toContain("2/10 Net 30");
      expect(html).toContain("0–15 Days (Current)");
      expect(html).toContain("60+ Days (Critical)");

      // Optimizer & Bank Matrix proofs
      expect(html).toContain("Razorpay Optimizer Tier-0 In-Flight Gateway & Bank Health Matrix");
      expect(html).toContain("Top 4 Indian Issuer Bank Switch Real-Time Telemetry");
      expect(html).toContain("Evaluate Inter-Bank Circuit Breaker");
    });
  });

  describe("2. End-to-End Multi-Domain Backend API Feeds", () => {
    it("GET /api/mandates feeds active recurring subscriptions", async () => {
      const res = await fetch(`${baseUrl}/api/mandates`);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data).toHaveProperty("mandates");
      expect(Array.isArray(data.mandates)).toBe(true);
    });

    it("GET /api/invoices feeds corporate accounts receivable", async () => {
      const res = await fetch(`${baseUrl}/api/invoices`);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data).toHaveProperty("invoices");
      expect(Array.isArray(data.invoices)).toBe(true);
    });

    it("GET /api/rails/health feeds Top 4 Indian banking switches and payment rails", async () => {
      const res = await fetch(`${baseUrl}/api/rails/health`);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.snapshot.banks.length).toBe(4);
      expect(data.snapshot.overallRailHealth.rails.length).toBe(5);
    });

    it("GET /api/optimizer/metrics feeds in-flight cascade telemetry", async () => {
      const res = await fetch(`${baseUrl}/api/optimizer/metrics`);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.metrics).toHaveProperty("inFlightRecovered");
      expect(data.metrics).toHaveProperty("totalCogsSavedPaise");
    });
  });

  describe("3. Interactive Dashboard Domain Action Triggers", () => {
    it("executes simulated SaaS Mandate Failure & Invariant Test via POST /api/mandates/auto-debit-failure", async () => {
      const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const res = await fetch(`${baseUrl}/api/mandates/auto-debit-failure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: `cust_dash_${uniq}`,
          mandateId: `man_dash_${uniq}`,
          customerName: "Executive Demo Subscriber",
          customerPhone: "+919876543210",
          planName: `Pro SaaS Enterprise ${uniq}`,
          amountPaise: 499900,
          failureCode: "INSUFFICIENT_FUNDS",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data).toHaveProperty("retryPlan");
      expect(data.retryPlan).toHaveProperty("scheduledDebitAtUtc");
      expect(data.retryPlan.scheduledDebitAtUtc).toContain("T01:00:00"); // 06:30 IST is 01:00 UTC
    });

    it("executes simulated B2B 2/10 Net 30 Chaser via POST /api/invoices/chaser/initiate", async () => {
      const uniqInv = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const res = await fetch(`${baseUrl}/api/invoices/chaser/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          buyerName: `Infosys Global Systems ${uniqInv}`,
          invoiceNumber: `INV-${uniqInv.toUpperCase()}`,
          invoiceAmountPaise: 25000000,
          daysPastDue: 32,
          contactPhone: "+919988776655",
          contactEmail: "ap@infosys-demo.com",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data).toHaveProperty("chaserPlan");
      expect(data.chaserPlan).toHaveProperty("discountSavedPaise");
      expect(data.chaserPlan.discountSavedPaise).toBe(500000); // 2% of 25000000
    });

    it("executes interactive Inter-Bank Circuit Breaker evaluation via POST /api/banks/circuit-breaker/evaluate", async () => {
      const res = await fetch(`${baseUrl}/api/banks/circuit-breaker/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "rohit@okhdfcbank",
          preferredMethod: "upi",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.evaluation).toHaveProperty("allowed");
      expect(data.evaluation).toHaveProperty("circuitState");
      expect(data.evaluation).toHaveProperty("steeringMessage");
    });
  });
});
