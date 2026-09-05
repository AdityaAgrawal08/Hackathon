import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import { runRealBatchRecovery } from "../../scripts/run_real_batch_recovery.js";

const TEST_DB_URL = "file:./data/arbiter_test.sqlite";

describe("FIX-021: Real Batch Recovery Measurement & Cryptographic Audit Verification", () => {
  let client: Client;

  beforeAll(async () => {
    client = createClient({ url: TEST_DB_URL });
    await runMigrations(client);
  });

  it("executes 50-payment batch recovery with realistic Indian banking errors", async () => {
    const metrics = await runRealBatchRecovery(client, 50);

    expect(metrics).toBeDefined();

    // 1. Measured money recovered
    expect(metrics.totalTransactions).toBe(50);
    expect(metrics.totalAtRiskPaise).toBeGreaterThan(0);
    expect(metrics.totalRecoveredPaise).toBeGreaterThan(0);
    expect(metrics.totalRecoveredPaise).toBeLessThanOrEqual(metrics.totalAtRiskPaise);
    expect(metrics.recoveryRatePercent).toBeGreaterThan(0);
    expect(metrics.recoveryRatePercent).toBeLessThanOrEqual(100);

    // 2. Net margin & MDR rail arbitrage
    expect(metrics.mdrArbitrageSavingsPaise).toBeGreaterThan(0);
    expect(metrics.netRecoveryLiftPercent).toBeGreaterThan(0);

    // 3. Formatted currency representations
    expect(metrics.totalAtRiskFormatted).toContain("₹");
    expect(metrics.totalRecoveredFormatted).toContain("₹");
    expect(metrics.mdrSavingsFormatted).toContain("₹");

    // 4. SHA-256 Tamper-evident audit chain
    expect(metrics.auditChainValid).toBe(true);
    expect(metrics.auditEntriesCount).toBeGreaterThan(0);

    // 5. Transaction level validation
    expect(metrics.transactionsSummary.length).toBe(50);
    for (const tx of metrics.transactionsSummary) {
      expect(tx.eventId).toBeDefined();
      expect(tx.failureCode).toBeDefined();
      expect(tx.banditAction).toBeDefined();
      expect(typeof tx.recovered).toBe("boolean");
      expect(tx.amountFormatted).toContain("₹");
    }
  });

  it("preserves strict audit chain tamper-evidence when ledger is validated", async () => {
    const metrics = await runRealBatchRecovery(client, 20);
    expect(metrics.auditChainValid).toBe(true);
    expect(metrics.auditEntriesCount).toBeGreaterThan(0);
  });
});
