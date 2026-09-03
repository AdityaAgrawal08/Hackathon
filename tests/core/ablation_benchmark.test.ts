/**
 * Automated Tests for 4-Way Baseline Ablation Benchmark (Task 6.3 / BEN-15)
 */
import { describe, it, expect } from "vitest";
import { runFourWayAblationBenchmark } from "../../packages/core/src/decide/ablation_benchmark.js";

describe("Task 6.3 / BEN-15: 4-Way Comparative Baseline Ablation Benchmark", () => {
  it("executes 4-way benchmark across 1,000 transactions and returns all arms with valid CIs", () => {
    const report = runFourWayAblationBenchmark(1000, 0x5eed);

    expect(report.batchSize).toBe(1000);
    expect(report.seed).toBe("0x5EED");
    expect(report.totalAtRiskPaise).toBeGreaterThan(50000000); // > ₹5,00,000

    const { control, blindRetries, staticRules, arbiter } = report.arms;

    // Verify Arm 0: Control
    expect(control.armId).toBe("ARM_0_CONTROL");
    expect(control.recoveryRatePercent).toBeGreaterThan(15);
    expect(control.recoveryRatePercent).toBeLessThan(25);
    expect(control.totalCostPaise).toBe(0);

    // Verify Arm 1: Blind Retries
    expect(blindRetries.armId).toBe("ARM_1_BLIND_RETRIES");
    expect(blindRetries.recoveryRatePercent).toBeGreaterThan(control.recoveryRatePercent);
    expect(blindRetries.unitCostPer100Won).toBeGreaterThan(0);

    // Verify Arm 2: Static Rules
    expect(staticRules.armId).toBe("ARM_2_STATIC_RULES");
    expect(staticRules.recoveryRatePercent).toBeGreaterThan(blindRetries.recoveryRatePercent);

    // Verify Arm 3: ARBITER (ML + FSM + EV)
    expect(arbiter.armId).toBe("ARM_3_ARBITER");
    expect(arbiter.recoveryRatePercent).toBeGreaterThan(staticRules.recoveryRatePercent);
    expect(arbiter.mdrSavingsPaise).toBeGreaterThan(0);
    expect(arbiter.unitCostPer100Won).toBeLessThanOrEqual(staticRules.unitCostPer100Won);

    // ARBITER must deliver massive lift over Control and Rules
    expect(report.liftVsControlPaise).toBeGreaterThan(0);
    expect(report.liftVsRulesPaise).toBeGreaterThan(0);
  });

  it("proves 100% deterministic reproducibility under identical random seed (Seed Lock Invariant)", () => {
    const report1 = runFourWayAblationBenchmark(1000, 0xcafe);
    const report2 = runFourWayAblationBenchmark(1000, 0xcafe);

    expect(report1.totalAtRiskPaise).toBe(report2.totalAtRiskPaise);
    expect(report1.arms.arbiter.recoveredPaise).toBe(report2.arms.arbiter.recoveredPaise);
    expect(report1.arms.arbiter.netMarginPreservedPaise).toBe(report2.arms.arbiter.netMarginPreservedPaise);
    expect(report1.arms.arbiter.mdrSavingsPaise).toBe(report2.arms.arbiter.mdrSavingsPaise);
    expect(report1.arms.control.recoveredPaise).toBe(report2.arms.control.recoveredPaise);
  });

  it("API /api/benchmark/four-way returns 4-way comparative report with valid seed and lift", async () => {
    const { app } = await import("../../app/server.js");
    const server = app.listen(0);
    const addr = server.address() as any;
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/benchmark/four-way?size=500&seed=beef`);
    const data = await res.json() as any;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(res.status).toBe(200);
    expect(data.batchSize).toBe(500);
    expect(data.seed).toBe("0xBEEF");
    expect(data.arms.arbiter).toBeDefined();
    expect(data.arms.control).toBeDefined();
    expect(data.arms.blindRetries).toBeDefined();
    expect(data.arms.staticRules).toBeDefined();
  });
});
