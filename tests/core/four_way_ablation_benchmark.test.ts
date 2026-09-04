/**
 * Comprehensive Automated Tests for Hardened 4-Way CFO Ablation Benchmark Engine (Phase 6)
 */
import { describe, it, expect } from "vitest";
import { runFourWayAblationBenchmark } from "../../packages/core/src/decide/ablation_benchmark.js";

describe("Phase 6 / Task 6.1: 4-Way CFO Baseline Ablation Benchmark Engine", () => {
  it("executes standard 1,000-transaction benchmark with default seed 0x5EED and validates all financial fields", () => {
    const report = runFourWayAblationBenchmark(1000, 0x5eed);

    expect(report.batchSize).toBe(1000);
    expect(report.seed).toBe("0x5EED");
    expect(report.totalAtRiskPaise).toBeGreaterThan(50000000); // > ₹5,00,000
    expect(report.formattedTotalAtRisk).toMatch(/^₹/);

    const { control, blindRetries, staticRules, arbiter } = report.arms;

    // Arm 0: Control
    expect(control.armId).toBe("ARM_0_CONTROL");
    expect(control.recoveryRatePercent).toBeGreaterThan(15);
    expect(control.recoveryRatePercent).toBeLessThan(25);
    expect(control.totalCostPaise).toBe(0);
    expect(control.unitCostPer100Won).toBe(0);

    // Arm 1: Blind Retries
    expect(blindRetries.armId).toBe("ARM_1_BLIND_RETRIES");
    expect(blindRetries.recoveryRatePercent).toBeGreaterThan(control.recoveryRatePercent);
    expect(blindRetries.totalCostPaise).toBe(1000 * 3 * 25); // 3 retries @ 25p = 75,000 paise (₹750)
    expect(blindRetries.unitCostPer100Won).toBeGreaterThan(0);

    // Arm 2: Static Rules
    expect(staticRules.armId).toBe("ARM_2_STATIC_RULES");
    expect(staticRules.recoveryRatePercent).toBeGreaterThan(blindRetries.recoveryRatePercent);
    expect(staticRules.totalCostPaise).toBe(1000 * (18 + 8)); // SMS(18) + Email(8) = 26,000 paise (₹260)

    // Arm 3: ARBITER (ML + FSM + EV)
    expect(arbiter.armId).toBe("ARM_3_ARBITER");
    expect(arbiter.recoveryRatePercent).toBeGreaterThan(staticRules.recoveryRatePercent);
    expect(arbiter.mdrSavingsPaise).toBeGreaterThan(0);
    expect(arbiter.unitCostPer100Won).toBeLessThanOrEqual(staticRules.unitCostPer100Won);
    expect(arbiter.netMarginPreservedPaise).toBeGreaterThan(staticRules.netMarginPreservedPaise);

    // Incremental Lift & Bootstrap CI invariants
    expect(report.liftVsControlPaise).toBeGreaterThan(0);
    expect(report.liftVsRulesPaise).toBeGreaterThan(0);
    expect(arbiter.ci95LowPercent).toBeLessThanOrEqual(arbiter.recoveryRatePercent);
    expect(arbiter.ci95HighPercent).toBeGreaterThanOrEqual(arbiter.recoveryRatePercent);
  });

  it("supports options object with custom COGS and overrides without hardcoding", () => {
    const report = runFourWayAblationBenchmark({
      batchSize: 500,
      seed: 0x1337,
      channelCogs: {
        gatewayRetryPaise: 30,
        smsPaise: 20,
        emailPaise: 10,
      },
      domain: "b2b",
      minTicketInr: 10000,
      maxTicketInr: 50000,
    });

    expect(report.batchSize).toBe(500);
    expect(report.seed).toBe("0x1337");
    expect(report.domain).toBe("b2b");
    // Tickets between ₹10k and ₹50k across 500 items -> > ₹50,00,000
    expect(report.totalAtRiskPaise).toBeGreaterThan(50000000);

    // Costs should reflect overrides
    expect(report.arms.blindRetries.totalCostPaise).toBe(500 * 3 * 30);
    expect(report.arms.staticRules.totalCostPaise).toBe(500 * (20 + 10));

    // B2B domain must calculate working capital interest savings
    expect(report.workingCapitalSavedPaise).toBeDefined();
    expect(report.workingCapitalSavedPaise!).toBeGreaterThan(0);
    expect(report.formattedWorkingCapitalSaved).toMatch(/^₹/);
  });

  it("guarantees 100% deterministic seed lock reproducibility", () => {
    const r1 = runFourWayAblationBenchmark({ batchSize: 750, seed: 0xfeed });
    const r2 = runFourWayAblationBenchmark({ batchSize: 750, seed: 0xfeed });

    expect(r1.totalAtRiskPaise).toBe(r2.totalAtRiskPaise);
    expect(r1.arms.arbiter.recoveredPaise).toBe(r2.arms.arbiter.recoveredPaise);
    expect(r1.arms.arbiter.recoveryRatePercent).toBe(r2.arms.arbiter.recoveryRatePercent);
    expect(r1.arms.control.recoveredPaise).toBe(r2.arms.control.recoveredPaise);
    expect(r1.liftVsRulesPaise).toBe(r2.liftVsRulesPaise);
  });

  it("enforces zero WhatsApp or Voice references across all arm descriptions", () => {
    const report = runFourWayAblationBenchmark(100);
    const jsonStr = JSON.stringify(report).toLowerCase();

    expect(jsonStr).not.toContain("whatsapp");
    expect(jsonStr).not.toContain("voice");
  });
});
