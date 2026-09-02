import { describe, it, expect } from "vitest";
import { runBatchBenchmark } from "../../app/recovery.js";

describe("Empirical 3-Arm Ablation Benchmark (BENCH-02)", () => {
  it("computes 3-arm comparison with bootstrap confidence intervals and unit economics", async () => {
    const report = await runBatchBenchmark(undefined, 200);

    // 1. Structure Verification
    expect(report.batchSize).toBe(200);
    expect(report.totalAtRiskPaise).toBeGreaterThan(0);

    // 2. Arm 0: Control Strategy (Natural Self-Cure Baseline)
    expect(report.naive).toBeDefined();
    expect(report.naive.recoveredRevenuePaise).toBeGreaterThan(0);
    const controlRate = parseFloat(report.naive.recoveryRate);
    expect(controlRate).toBeGreaterThan(10);
    expect(controlRate).toBeLessThan(30);

    // 3. Arm 1: 7-Rule Heuristic Baseline
    expect(report.rulesBaseline).toBeDefined();
    expect(report.rulesBaseline.recoveredRevenuePaise).toBeGreaterThan(report.naive.recoveredRevenuePaise);
    const rulesRate = parseFloat(report.rulesBaseline.recoveryRate);
    expect(rulesRate).toBeGreaterThan(controlRate);
    expect(report.rulesBaseline.totalCostPaise).toBeGreaterThan(0);

    // 4. Arm 2: ARBITER ML + EV Decision Engine
    expect(report.arbiter).toBeDefined();
    expect(report.arbiter.recoveredRevenuePaise).toBeGreaterThanOrEqual(report.rulesBaseline.recoveredRevenuePaise);
    const arbiterRate = parseFloat(report.arbiter.recoveryRate);
    expect(arbiterRate).toBeGreaterThan(rulesRate);

    // 5. Delta & Incremental Lift
    expect(report.delta).toBeDefined();
    expect(report.delta.additionalRevenueOverRulesPaise).toBeGreaterThan(0);
    expect(report.delta.liftOverRulesPercent).toBeGreaterThan(0);
    expect(report.delta.liftOverControlPercent).toBeGreaterThan(0);

    // 6. Bootstrap 95% Confidence Intervals (1,000 resamples)
    expect(report.bootstrap).toBeDefined();
    expect(report.bootstrap.liftOverRules).toBeDefined();
    expect(Number.isFinite(report.bootstrap.liftOverRules.lowPp)).toBe(true);
    expect(Number.isFinite(report.bootstrap.liftOverRules.highPp)).toBe(true);
    expect(report.bootstrap.liftOverRules.highPp).toBeGreaterThanOrEqual(report.bootstrap.liftOverRules.lowPp);
    expect(report.bootstrap.liftOverRules.meanPp).toBeGreaterThan(0);
    expect(report.bootstrap.liftOverRules.pValue).toBeLessThanOrEqual(0.05);

    // 7. Unit Economics (Cost per ₹100 Won)
    expect(report.unitEconomics).toBeDefined();
    expect(report.unitEconomics.costPer100WonArbiter).toBeGreaterThan(0);
    expect(report.unitEconomics.costPer100WonArbiter).toBeLessThan(10); // Less than ₹10 per ₹100 won
    expect(report.unitEconomics.netRevenueWonArbiterPaise).toBeGreaterThan(report.unitEconomics.netRevenueWonRulesPaise);
    expect(report.unitEconomics.netRevenueWonRulesPaise).toBeGreaterThan(report.unitEconomics.netRevenueWonControlPaise);

    // 8. Per-failure-class and Per-channel metrics
    expect(Object.keys(report.perFailureClass).length).toBeGreaterThan(0);
    expect(report.perChannelCost.totalOutreachPaise).toBeGreaterThan(0);
    expect(report.timeToRecovery.sampleSize).toBeGreaterThan(0);
  });

  it("reproducibility invariant: running benchmark multiple times produces identical outcomes", async () => {
    const report1 = await runBatchBenchmark();
    const report2 = await runBatchBenchmark();

    expect(report1.totalAtRiskPaise).toBe(report2.totalAtRiskPaise);
    expect(report1.arbiterRecoveredPaise).toBe(report2.arbiterRecoveredPaise);
    expect(report1.rulesBaseline.recoveredRevenuePaise).toBe(report2.rulesBaseline.recoveredRevenuePaise);
    expect(report1.naive.recoveredRevenuePaise).toBe(report2.naive.recoveredRevenuePaise);
    expect(report1.bootstrap.liftOverRules.meanPp).toBe(report2.bootstrap.liftOverRules.meanPp);
  });
});
