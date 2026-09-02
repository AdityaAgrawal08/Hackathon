import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import express from "express";
import { createClient, type Client } from "@libsql/client";
import { runMigrations, appendAuditLedger, getAuditLedgerForEntity, verifyAuditLedgerChain } from "../../packages/core/src/index.js";
import { runBatchBenchmark } from "../../app/recovery.js";

describe("Phase 4: Vendor Dashboard Live Telemetry, 1-Click Benchmark & Audit Trail", () => {
  let db: Client;

  beforeAll(async () => {
    db = createClient({ url: ":memory:" });
    await runMigrations(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it("Task 4.1: 1-Click Batch Benchmark API returns 3-Arm ablation results with bootstrap 95% CIs", async () => {
    const benchmark = await runBatchBenchmark(100);

    expect(benchmark).toBeDefined();
    expect(benchmark.batchSize).toBe(100);

    // Verify 3 distinct arms
    expect(benchmark.arms).toBeDefined();
    expect(benchmark.arms.arm0Control).toBeDefined();
    expect(benchmark.arms.arm1RulesBaseline).toBeDefined();
    expect(benchmark.arms.arm2ArbiterML).toBeDefined();

    // Verify Arm metrics
    const arm0 = benchmark.arms.arm0Control;
    const arm1 = benchmark.arms.arm1RulesBaseline;
    const arm2 = benchmark.arms.arm2ArbiterML;

    expect(parseFloat(arm0.recoveryRate)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(arm1.recoveryRate)).toBeGreaterThanOrEqual(parseFloat(arm0.recoveryRate));
    expect(parseFloat(arm2.recoveryRate)).toBeGreaterThanOrEqual(parseFloat(arm1.recoveryRate));

    // Verify bootstrap confidence intervals and unit economics
    expect(benchmark.bootstrap95ConfidenceInterval).toBeDefined();
    expect(benchmark.bootstrap95ConfidenceInterval.rateDeltaCiLow).toBeDefined();
    expect(benchmark.bootstrap95ConfidenceInterval.rateDeltaCiHigh).toBeDefined();
    expect(benchmark.costPer100Won).toBeDefined();
    expect(benchmark.costPer100Won).toBeGreaterThanOrEqual(0);
  });

  it("Task 4.2: SHA-256 Audit Ledger records chained lifecycle events with cryptographic proof", async () => {
    const testEntityId = `evt_test_audit_${Date.now()}`;
    const testCustomerId = `cust_test_${Date.now()}`;
    const nowMs = Date.now();

    // Step 1: EVENT_DETECTED
    const e1 = await appendAuditLedger(db, {
      eventType: "EVENT_DETECTED",
      entityId: testEntityId,
      customerId: testCustomerId,
      payload: { paymentId: "pay_123", amountPaise: 499900 },
      nowMs,
    });
    expect(e1.prevHash).toBe("GENESIS");
    expect(e1.entryHash).toMatch(/^[a-f0-9]{64}$/);

    // Step 2: DIAGNOSED
    const e2 = await appendAuditLedger(db, {
      eventType: "DIAGNOSED",
      entityId: testEntityId,
      customerId: testCustomerId,
      payload: { code: "insufficient_funds", failureClass: "SOFT_RETRYABLE" },
      nowMs: nowMs + 1000,
    });
    expect(e2.prevHash).toBe(e1.entryHash);
    expect(e2.entryHash).toMatch(/^[a-f0-9]{64}$/);

    // Step 3: POLICY_EVALUATED
    const e3 = await appendAuditLedger(db, {
      eventType: "POLICY_EVALUATED",
      entityId: testEntityId,
      customerId: testCustomerId,
      payload: { action: "ALTERNATE_UPI_LINK", expectedValuePaise: 389000 },
      nowMs: nowMs + 2000,
    });
    expect(e3.prevHash).toBe(e2.entryHash);

    // Step 4: OUTREACH_DISPATCHED
    const e4 = await appendAuditLedger(db, {
      eventType: "OUTREACH_DISPATCHED",
      entityId: testEntityId,
      customerId: testCustomerId,
      payload: { channel: "SMS", provider: "msg91" },
      nowMs: nowMs + 3000,
    });
    expect(e4.prevHash).toBe(e3.entryHash);

    // Step 5: PAYMENT_RECOVERED
    const e5 = await appendAuditLedger(db, {
      eventType: "PAYMENT_RECOVERED",
      entityId: testEntityId,
      customerId: testCustomerId,
      payload: { razorpayPaymentId: "pay_rec_999", amountPaise: 499900 },
      nowMs: nowMs + 4000,
    });
    expect(e5.prevHash).toBe(e4.entryHash);

    // Verify entity retrieval
    const trail = await getAuditLedgerForEntity(db, testEntityId);
    expect(trail.length).toBe(5);
    expect(trail[0].eventType).toBe("EVENT_DETECTED");
    expect(trail[4].eventType).toBe("PAYMENT_RECOVERED");

    // Verify global chain integrity
    const chainCheck = await verifyAuditLedgerChain(db);
    expect(chainCheck.valid).toBe(true);
    expect(chainCheck.totalEntries).toBeGreaterThanOrEqual(5);
  });
});
