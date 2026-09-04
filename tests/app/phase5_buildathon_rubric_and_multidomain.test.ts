/**
 * Specialized Test Suite for Track 03 Phase 5: Buildathon Rubric Alignment & Multi-Domain UI Integration
 * 
 * Validates:
 * 1. Multi-domain dashboard navigation and panel visibility (zero display-none suppression)
 * 2. Regulatory proofs rendered across all 6 enterprise cockpits
 * 3. End-to-end multi-domain backend API feeds
 * 4. Interactive domain action triggers (Mandate retries, B2B 2/10 Net 30 chaser, Bank circuit breaker)
 * 5. Track 03 Rubric Traceability Table in README.md & empirical negative results documentation
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { app, dbClient } from "../../app/server.js";
import { runMigrations } from "../../packages/core/src/db/migrate.js";

describe("Phase 5: Buildathon Rubric Alignment & Multi-Domain UI Integration", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await runMigrations(dbClient);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
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

  describe("1. Multi-Domain Dashboard Navigation & Panel Visibility", () => {
    it("renders GET /dashboard with 200 OK and all 6 visible navigation tab buttons", async () => {
      const res = await fetch(`${baseUrl}/dashboard`);
      expect(res.status).toBe(200);

      const html = await res.text();

      // All 6 tabs must exist
      expect(html).toContain('id="tab-transactions"');
      expect(html).toContain('id="tab-behavioral-memory"');
      expect(html).toContain('id="tab-mandates"');
      expect(html).toContain('id="tab-invoices"');
      expect(html).toContain('id="tab-bank-matrix"');
      expect(html).toContain('id="tab-recovery-report"');

      // None of the tabs should be hidden via inline display:none
      const tabNavMatch = html.match(/<div class="tab-nav">([\s\S]*?)<\/div>/);
      expect(tabNavMatch).not.toBeNull();
      const tabNavContent = tabNavMatch![1];
      expect(tabNavContent).not.toContain('style="display:none');
      expect(tabNavContent).not.toContain("display: none !important");
    });

    it("contains all 6 dedicated domain cockpit panels with zero inline suppression", async () => {
      const res = await fetch(`${baseUrl}/dashboard`);
      const html = await res.text();

      expect(html).toContain('id="panel-transactions"');
      expect(html).toContain('id="panel-behavioral-memory"');
      expect(html).toContain('id="panel-mandates"');
      expect(html).toContain('id="panel-invoices"');
      expect(html).toContain('id="panel-bank-matrix"');
      expect(html).toContain('id="panel-recovery-report"');

      // Crucial: panel-mandates and panel-invoices must NOT be suppressed with display:none !important
      expect(html).not.toContain('<div class="tab-panel" id="panel-mandates" style="display:none !important;"');
      expect(html).not.toContain('<div class="tab-panel" id="panel-invoices" style="display:none !important;"');
    });
  });

  describe("2. Regulatory & Domain Invariant Proofs in DOM", () => {
    it("verifies SaaS recurring mandate regulatory proofs", async () => {
      const res = await fetch(`${baseUrl}/dashboard`);
      const html = await res.text();

      expect(html).toContain("06:30 AM IST");
      expect(html).toContain("RBI 24h Notice Proof");
      expect(html).toContain("100% COMPLIANT");
      expect(html).toContain("UPI Autopay");
      expect(html).toContain("simulateMandateRun");
    });

    it("verifies B2B invoices and working capital proofs", async () => {
      const res = await fetch(`${baseUrl}/dashboard`);
      const html = await res.text();

      expect(html).toContain('data-terms="2/10 Net 30"');
      expect(html).toContain("Days Sales Outstanding");
      expect(html).toContain("2/10 Net 30");
      expect(html).toContain("0–15 Days (Current)");
      expect(html).toContain("60+ Days (Critical)");
      expect(html).toContain("Smart Collect");
    });

    it("verifies Razorpay Optimizer & Bank Matrix proofs", async () => {
      const res = await fetch(`${baseUrl}/dashboard`);
      const html = await res.text();

      expect(html).toContain("Razorpay Optimizer Tier-0 In-Flight Gateway & Bank Health Matrix");
      expect(html).toContain("Top 4 Indian Issuer Bank Switch Real-Time Telemetry");
      expect(html).toContain("Evaluate Inter-Bank Circuit Breaker");
    });

    it("verifies Behavioral Memory & Priority Queue proofs", async () => {
      const res = await fetch(`${baseUrl}/dashboard`);
      const html = await res.text();

      expect(html).toContain("Behavioral Memory & Priority Queue");
      expect(html).toContain("Persistent database profiles tracking responsiveness");
      expect(html).toContain("⚡ Intelligent Dynamic EV Priority Queue (Batch Sequencer)");
    });
  });

  describe("3. Multi-Domain Backend API Feeds & Interactive Triggers", () => {
    it("GET /api/mandates returns recurring mandate subscriptions", async () => {
      const res = await fetch(`${baseUrl}/api/mandates`);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data).toHaveProperty("mandates");
      expect(Array.isArray(data.mandates)).toBe(true);
    });

    it("GET /api/invoices returns accounts receivable ledger", async () => {
      const res = await fetch(`${baseUrl}/api/invoices`);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data).toHaveProperty("invoices");
      expect(Array.isArray(data.invoices)).toBe(true);
    });

    it("GET /api/rails/health returns Top 4 Indian banking switches and payment rails", async () => {
      const res = await fetch(`${baseUrl}/api/rails/health`);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.snapshot.banks.length).toBe(4);
      expect(data.snapshot.overallRailHealth.rails.length).toBe(5);
    });

    it("GET /api/optimizer/metrics returns in-flight cascade telemetry", async () => {
      const res = await fetch(`${baseUrl}/api/optimizer/metrics`);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });

    it("executes simulated Mandate Failure & Invariant Test via POST /api/mandates/auto-debit-failure", async () => {
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

  describe("4. Track 03 Rubric Traceability & Negative Results Documentation", () => {
    it("verifies README.md contains Track 03 Rubric Traceability Table mapping all criteria", () => {
      const readmePath = resolve(process.cwd(), "README.md");
      const content = readFileSync(readmePath, "utf-8");

      expect(content).toContain("Track 03: Official Buildathon Rubric Traceability Table");
      expect(content).toContain("The Bar: Measured Money Recovered Across a Batch");
      expect(content).toContain("The Bar: Compliant Escalation & Stopping Rules");
      expect(content).toContain("The Bar: Cryptographic Tamper-Evident Audit Trail");
      expect(content).toContain("The Edge: Sub-Millisecond Discrete Error Catalog");
      expect(content).toContain("The Edge: Mathematical Expected Value & Online Reinforcement Learning");
      expect(content).toContain("The Edge: 1-Tap Customer Retention & Active Re-Planning");
      expect(content).toContain("The Edge: Multi-Domain Enterprise Financial Architecture");
      expect(content).toContain("Production Concurrency & Scalability");
    });

    it("verifies docs/negative-results.md contains all 4 empirical negative findings", () => {
      const negPath = resolve(process.cwd(), "docs/negative-results.md");
      const content = readFileSync(negPath, "utf-8");

      expect(content).toContain("Negative Finding 1: LLM-Based Error Classification on the Money Path");
      expect(content).toContain("Negative Finding 2: Uncalibrated Issuer Outage Detection without Live NPCI Feeds");
      expect(content).toContain("Negative Finding 3: Local Silo Variance in Merchant Federated Learning");
      expect(content).toContain("Negative Finding 4: Voice IVR & WhatsApp Channel Friction in India");
    });
  });
});
