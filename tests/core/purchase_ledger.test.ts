/**
 * Automated Tests for Task 6.9 / PURCH-10: Immutable Credential-Bound Purchase Ledger
 */
import { describe, it, expect } from "vitest";
import {
  appendPurchaseLedger,
  getCredentialBehavioralMetrics,
} from "../../packages/core/src/ledger/purchase_ledger.js";

describe("Task 6.9 / PURCH-10: Immutable Credential-Bound Purchase Ledger", () => {
  it("returns default neutral prior metrics for fresh credential with 0 transactions", async () => {
    const { dbClient } = await import("../../app/server.js");
    const { runMigrations } = await import("../../packages/core/src/db/migrate.js");
    await runMigrations(dbClient);

    const metrics = await getCredentialBehavioralMetrics(dbClient, "cred_fresh_001", 199900);
    expect(metrics.totalTransactions).toBe(0);
    expect(metrics.lifetimeSuccessRate).toBe(0.5);
    expect(metrics.velocity24hFailures).toBe(0);
    expect(metrics.txRecencyDays).toBeNull();
    expect(metrics.ticketZScore).toBe(0);
  });

  it("appends historical transactions and computes accurate temporal behavioral features", async () => {
    const { dbClient } = await import("../../app/server.js");
    const { runMigrations } = await import("../../packages/core/src/db/migrate.js");
    const { resolveOrCreateCredential } = await import("../../packages/core/src/db/credential.js");
    await runMigrations(dbClient);

    const nowMs = Date.now();
    const credId = await resolveOrCreateCredential(dbClient, `98${Math.floor(10000000 + Math.random() * 90000000)}`, "hist@test.com");

    // 1. Transaction 10 days ago: SUCCESS (₹2,000)
    await appendPurchaseLedger(dbClient, {
      credentialId: credId,
      amountPaise: 200000,
      paymentMethod: "upi",
      status: "SUCCESS",
      occurredAtUtc: new Date(nowMs - 10 * 86400000).toISOString(),
    });

    // 2. Transaction 2 hours ago: FAILED (₹5,000)
    await appendPurchaseLedger(dbClient, {
      credentialId: credId,
      amountPaise: 500000,
      paymentMethod: "card",
      status: "FAILED",
      failureCode: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
      occurredAtUtc: new Date(nowMs - 2 * 3600000).toISOString(),
    });

    // 3. Transaction 1 hour ago: RECOVERED (₹5,000)
    await appendPurchaseLedger(dbClient, {
      credentialId: credId,
      amountPaise: 500000,
      paymentMethod: "upi",
      status: "RECOVERED",
      occurredAtUtc: new Date(nowMs - 1 * 3600000).toISOString(),
    });

    // Fetch behavioral features for incoming ₹10,000 transaction
    const metrics = await getCredentialBehavioralMetrics(dbClient, credId, 1000000, nowMs);

    expect(metrics.totalTransactions).toBe(3);
    expect(metrics.successCount).toBe(2); // 1 SUCCESS + 1 RECOVERED
    expect(metrics.failureCount).toBe(1);
    expect(metrics.lifetimeSuccessRate).toBeCloseTo(0.667, 2);
    expect(metrics.velocity24hFailures).toBe(1); // 1 failure within 24h
    expect(metrics.txRecencyDays).toBeLessThan(0.1); // most recent recovery 1h ago
    expect(metrics.ticketZScore).toBeGreaterThan(0); // ₹10,000 is higher than historical mean
  });
});
