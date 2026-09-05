import { describe, it, expect } from "vitest";
import {
  generateHistoricalDataset,
  parseHistoricalCsv,
  type HistoricalPaymentRecord,
} from "../../packages/core/src/decide/historical_dataset.js";
import {
  evaluatePolicyDoublyRobust,
  evaluateAllPoliciesCounterfactually,
  type PolicyEvaluator,
} from "../../packages/core/src/decide/off_policy_evaluation.js";

describe("TASK-002 & TASK-014: Off-Policy Evaluation (OPE) Engine", () => {
  const records: HistoricalPaymentRecord[] = generateHistoricalDataset(1000, 42);

  const testPolicy: PolicyEvaluator = (record) => {
    if (record.failureCategory === "TECHNICAL") {
      return { action: "GATEWAY_RETRY", probability: 0.95 };
    }
    if (record.isCard) {
      return { action: "1TAP_UPI_LINK", probability: 0.90 };
    }
    return { action: "SMS_1TAP_UPI", probability: 0.85 };
  };

  it("generates 1,000 valid historical failure records with logged propensities", () => {
    expect(records.length).toBe(1000);
    for (const r of records.slice(0, 20)) {
      expect(r.loggingPropensity).toBeGreaterThan(0);
      expect(r.loggingPropensity).toBeLessThanOrEqual(1);
      expect([true, false]).toContain(r.recovered);
      expect(r.amountPaise).toBeGreaterThan(0);
    }
  });

  it("calculates Doubly Robust and IPS value estimates without division by zero", () => {
    const result = evaluatePolicyDoublyRobust("Test Policy", records, testPolicy);

    expect(result.evaluatedCount).toBe(1000);
    expect(result.recoveryRatePercent).toBeGreaterThan(0);
    expect(result.recoveryRatePercent).toBeLessThan(100);

    expect(result.doublyRobustEstimate).toBeGreaterThan(0);
    expect(result.doublyRobustEstimate).toBeLessThan(1);

    expect(result.ipsEstimate).toBeGreaterThan(0);
    expect(result.directMethodEstimate).toBeGreaterThan(0);

    expect(result.recoveredGmvPaise).toBeGreaterThan(0);
    expect(result.totalAtRiskPaise).toBeGreaterThan(0);
    expect(result.effectiveSampleSize).toBeGreaterThan(0);
  });

  it("computes valid non-degenerate 95% bootstrap confidence intervals", () => {
    const result = evaluatePolicyDoublyRobust("Test Policy", records, testPolicy);

    expect(result.ci95LowPercent).toBeLessThanOrEqual(result.recoveryRatePercent);
    expect(result.ci95HighPercent).toBeGreaterThanOrEqual(result.recoveryRatePercent);
    expect(result.ci95HighPercent).toBeLessThanOrEqual(100);
    expect(result.ci95LowPercent).toBeGreaterThanOrEqual(0);
  });

  it("evaluates all 4 counterfactual policies and measures empirical lift", () => {
    const benchmark = evaluateAllPoliciesCounterfactually(records);

    expect(benchmark.datasetSize).toBe(1000);
    expect(benchmark.totalAtRiskPaise).toBeGreaterThan(0);
    expect(benchmark.policies.control.recoveryRatePercent).toBeLessThan(
      benchmark.policies.arbiterAgent.recoveryRatePercent,
    );
    expect(benchmark.policies.arbiterAgent.doublyRobustEstimate).toBeGreaterThan(
      benchmark.policies.naiveRetry.doublyRobustEstimate,
    );

    expect(benchmark.liftVsControlPaise).toBeGreaterThan(0);
    expect(benchmark.formattedLiftVsControl).toBeDefined();
    expect(benchmark.methodology).toBe("DOUBLY_ROBUST_OFF_POLICY_EVALUATION");
  });

  it("parses and evaluates custom CSV failure logs correctly", () => {
    const csvContent = [
      "payment_id,amount_paise,failure_code,method,recovered,logging_policy,logging_propensity",
      "pay_01,200000,GATEWAY_TIMEOUT,upi,1,CONTROL,0.45",
      "pay_02,500000,INSUFFICIENT_FUNDS,card,0,STATIC_RULES,0.30",
      "pay_03,150000,ISSUER_DOWN,upi,1,HISTORICAL_AGENT,0.25",
    ].join("\n");

    const parsed = parseHistoricalCsv(csvContent);
    expect(parsed.length).toBe(3);
    expect(parsed[0].amountPaise).toBe(200000);
    expect(parsed[0].recovered).toBe(true);

    const report = evaluateAllPoliciesCounterfactually(parsed);
    expect(report.datasetSize).toBe(3);
    expect(report.totalAtRiskPaise).toBe(850000);
  });
});
