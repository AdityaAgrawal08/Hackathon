/**
 * E-003: Sensitivity Analysis — perturbation tests for robustness.
 *
 * Varies:
 *   1. Failure class distribution (+/-10%)
 *   2. Amount distribution (+/-20%)
 *   3. Customer behavior (+/-15%)
 *
 * Reports recovery rate stability across perturbations.
 * Acceptance criteria: Recovery rate CI width < 5pp across perturbations.
 */
import { generateCorpus, type Corpus, type SeedCustomer, type SeedEvent } from "@arbiter/seed/generate";
import { paise, formatINR, hashSeed } from "@arbiter/shared";
import { buildTrainingDataset, type CorpusLike } from "./dataset.js";
import { splitByCustomer, assertDisjoint } from "./metrics.js";
import { scoreWithArtifact } from "./predict.js";
import { trainAndEvaluate } from "./train.js";
import { rulesOnlyAction, simulateRulesOutcome, type RulesContext } from "./baseline_rules.js";
import { classifyRazorpayError } from "@arbiter/core/diagnosis";
import type { FailureClassId } from "@arbiter/core/decide";
import { CONTROL_RATES } from "./control_arm.js";
import { evaluate, type EvaluationReport } from "./evaluate.js";

export interface PerturbationResult {
  name: string;
  mlRecoveryRate: number;
  rulesRecoveryRate: number;
  mlLift: number;
  mlCostPaise: number;
  rulesCostPaise: number;
}

export interface SensitivityReport {
  baseline: PerturbationResult;
  perturbations: PerturbationResult[];
  stability: {
    mlRateRange: { min: number; max: number; width: number };
    rulesRateRange: { min: number; max: number; width: number };
    stable: boolean; // CI width < 5pp
  };
}

/**
 * Apply failure class distribution perturbation (+/-delta).
 * Shifts event failure codes by remapping class shares.
 */
function perturbFailureClasses(corpus: Corpus, delta: number): Corpus {
  const rng = new Rng(`perturb:class:${delta}`);
  const events = corpus.events.map((e) => {
    if (rng.next() < Math.abs(delta)) {
      const classes = ["SOFT_RETRYABLE", "HARD_METHOD_DEAD", "NETWORK_TIMEOUT", "RISK_FLAGGED"] as const;
      const newClass = classes[rng.int(0, classes.length - 1)]!;
      const codes: Record<string, string[]> = {
        SOFT_RETRYABLE: ["INSUFFICIENT_FUNDS", "CARD_DECLINED"],
        HARD_METHOD_DEAD: ["CARD_EXPIRED", "DO_NOT_HONOR"],
        NETWORK_TIMEOUT: ["GATEWAY_TIMEOUT", "NETWORK_FAILURE"],
        RISK_FLAGGED: ["RISK_BLOCKED", "FRAUD_SUSPECTED"],
      };
      const newCodes = codes[newClass]!;
      return { ...e, failureCode: newCodes[rng.int(0, newCodes.length - 1)]! };
    }
    return e;
  });
  return { ...corpus, events };
}

/**
 * Apply amount perturbation (+/-pct).
 * Scales event amounts by (1 +/- pct).
 */
function perturbAmounts(corpus: Corpus, pct: number): Corpus {
  const rng = new Rng(`perturb:amount:${pct}`);
  const events = corpus.events.map((e) => {
    const factor = 1 + (rng.next() * 2 - 1) * pct;
    return { ...e, amountPaise: Math.round(e.amountPaise * factor) };
  });
  return { ...corpus, events };
}

/**
 * Apply customer behavior perturbation (+/-pct).
 * Adjusts channel responsiveness and prior success counts.
 */
function perturbBehavior(corpus: Corpus, pct: number): Corpus {
  const rng = new Rng(`perturb:behavior:${pct}`);
  const customers = corpus.customers.map((c) => {
    const newResponsiveness = Math.max(0.1, Math.min(1.0,
      c.channelResponsiveness + (rng.next() * 2 - 1) * pct
    ));
    return {
      ...c,
      channelResponsiveness: Math.round(newResponsiveness * 100) / 100,
      priorSuccessCount: Math.max(0, c.priorSuccessCount + (rng.next() > 0.5 ? 1 : -1)),
    };
  });
  return { ...corpus, customers };
}

/**
 * Evaluate a corpus with ML strategy and return recovery metrics.
 */
function evaluateCorpusML(corpus: Corpus): { recoveryRate: number; costPaise: number } {
  const dataset = buildTrainingDataset(corpus);
  const { train, holdout } = splitByCustomer(dataset.rows, 0.7);
  if (train.length === 0 || holdout.length === 0) {
    return { recoveryRate: 0, costPaise: 0 };
  }

  const { artifact } = trainAndEvaluate(corpus, { epochs: 500 });

  const eventMap = new Map(corpus.events.map((e) => [e.id, e]));
  const customerMap = new Map(corpus.customers.map((c) => [c.id, c]));

  let recovered = 0;
  let totalAtRisk = 0;
  let totalCost = 0;

  for (const row of holdout) {
    const event = eventMap.get(row.eventId);
    if (!event) continue;

    const amount = event.amountPaise;
    totalAtRisk += amount;

    const mlScore = scoreWithArtifact(row.values, artifact);
    const mlProb = mlScore.probability;
    const mlDraw = hashSeed(`ml_sens:${row.eventId}`) % 10_000;
    const failureClass = classifyRazorpayError(event.failureCode);
    const controlRate = CONTROL_RATES[failureClass] ?? 0.15;
    const mlEffectiveRate = mlProb >= 0.5 ? Math.min(1.0, controlRate + (mlProb - 0.3) * 0.8) : controlRate;
    const mlRecovered = mlDraw < Math.round(mlEffectiveRate * 10_000);

    if (mlRecovered) recovered += amount;
    totalCost += mlProb >= 0.5 ? 250 : 0;
  }

  return {
    recoveryRate: totalAtRisk > 0 ? recovered / totalAtRisk : 0,
    costPaise: totalCost,
  };
}

/**
 * Evaluate a corpus with rules strategy and return recovery metrics.
 */
function evaluateCorpusRules(corpus: Corpus): { recoveryRate: number; costPaise: number } {
  const eventMap = new Map(corpus.events.map((e) => [e.id, e]));
  const customerMap = new Map(corpus.customers.map((c) => [c.id, c]));

  let recovered = 0;
  let totalAtRisk = 0;
  let totalCost = 0;

  const dataset = buildTrainingDataset(corpus);
  const { holdout } = splitByCustomer(dataset.rows, 0.7);
  const nowMs = Date.UTC(2026, 0, 15, 14, 0, 0);

  for (const row of holdout) {
    const event = eventMap.get(row.eventId);
    if (!event) continue;

    const amount = event.amountPaise;
    totalAtRisk += amount;
    const failureClass = classifyRazorpayError(event.failureCode);
    const customer = customerMap.get(event.customerId);

    const ctx: RulesContext = {
      failureClass,
      inferredPaydayDay: customer?.paydayTrueDay ?? 28,
      nowMs,
      attemptsSoFar: 0,
      lastContactAtMs: null,
    };

    const result = simulateRulesOutcome(ctx, amount, hashSeed(row.eventId));
    if (result.wouldRecover) recovered += amount;
    totalCost += result.costPaise;
  }

  return {
    recoveryRate: totalAtRisk > 0 ? recovered / totalAtRisk : 0,
    costPaise: totalCost,
  };
}

// Minimal Rng for perturbation (avoids circular dep on @arbiter/shared Rng)
class Rng {
  private s: number;
  constructor(seed: string) {
    this.s = 0;
    for (let i = 0; i < seed.length; i++) {
      this.s = ((this.s << 5) - this.s + seed.charCodeAt(i)) | 0;
    }
  }
  next(): number {
    this.s = (this.s * 1664525 + 1013904223) | 0;
    return (this.s >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
}

/**
 * E-003: Run full sensitivity analysis.
 */
export function runSensitivityAnalysis(): SensitivityReport {
  const corpus = generateCorpus("demo", { customerCount: 40, targetEvents: 200 });

  // Baseline
  const baseMl = evaluateCorpusML(corpus);
  const baseRules = evaluateCorpusRules(corpus);
  const baseline: PerturbationResult = {
    name: "baseline",
    mlRecoveryRate: baseMl.recoveryRate,
    rulesRecoveryRate: baseRules.recoveryRate,
    mlLift: baseRules.recoveryRate > 0
      ? ((baseMl.recoveryRate - baseRules.recoveryRate) / baseRules.recoveryRate) * 100
      : 0,
    mlCostPaise: baseMl.costPaise,
    rulesCostPaise: baseRules.costPaise,
  };

  // Perturbations
  const perturbations: PerturbationResult[] = [];

  // 1. Failure class distribution +/-10%
  for (const delta of [-0.10, 0.10]) {
    const perturbed = perturbFailureClasses(corpus, delta);
    const ml = evaluateCorpusML(perturbed);
    const rules = evaluateCorpusRules(perturbed);
    perturbations.push({
      name: `class_shift_${delta > 0 ? "up" : "down"}`,
      mlRecoveryRate: ml.recoveryRate,
      rulesRecoveryRate: rules.recoveryRate,
      mlLift: rules.recoveryRate > 0 ? ((ml.recoveryRate - rules.recoveryRate) / rules.recoveryRate) * 100 : 0,
      mlCostPaise: ml.costPaise,
      rulesCostPaise: rules.costPaise,
    });
  }

  // 2. Amount distribution +/-20%
  for (const pct of [-0.20, 0.20]) {
    const perturbed = perturbAmounts(corpus, pct);
    const ml = evaluateCorpusML(perturbed);
    const rules = evaluateCorpusRules(perturbed);
    perturbations.push({
      name: `amount_shift_${pct > 0 ? "up" : "down"}`,
      mlRecoveryRate: ml.recoveryRate,
      rulesRecoveryRate: rules.recoveryRate,
      mlLift: rules.recoveryRate > 0 ? ((ml.recoveryRate - rules.recoveryRate) / rules.recoveryRate) * 100 : 0,
      mlCostPaise: ml.costPaise,
      rulesCostPaise: rules.costPaise,
    });
  }

  // 3. Customer behavior +/-15%
  for (const pct of [-0.15, 0.15]) {
    const perturbed = perturbBehavior(corpus, pct);
    const ml = evaluateCorpusML(perturbed);
    const rules = evaluateCorpusRules(perturbed);
    perturbations.push({
      name: `behavior_shift_${pct > 0 ? "up" : "down"}`,
      mlRecoveryRate: ml.recoveryRate,
      rulesRecoveryRate: rules.recoveryRate,
      mlLift: rules.recoveryRate > 0 ? ((ml.recoveryRate - rules.recoveryRate) / rules.recoveryRate) * 100 : 0,
      mlCostPaise: ml.costPaise,
      rulesCostPaise: rules.costPaise,
    });
  }

  // Stability analysis
  const allMlRates = [baseline.mlRecoveryRate, ...perturbations.map((p) => p.mlRecoveryRate)];
  const allRulesRates = [baseline.rulesRecoveryRate, ...perturbations.map((p) => p.rulesRecoveryRate)];

  const mlMin = Math.min(...allMlRates);
  const mlMax = Math.max(...allMlRates);
  const rulesMin = Math.min(...allRulesRates);
  const rulesMax = Math.max(...allRulesRates);

  const mlWidth = (mlMax - mlMin) * 100; // in percentage points
  const rulesWidth = (rulesMax - rulesMin) * 100;

  return {
    baseline,
    perturbations,
    stability: {
      mlRateRange: { min: mlMin, max: mlMax, width: Math.round(mlWidth * 10) / 10 },
      rulesRateRange: { min: rulesMin, max: rulesMax, width: Math.round(rulesWidth * 10) / 10 },
      stable: mlWidth < 5 && rulesWidth < 5, // CI width < 5pp
    },
  };
}

/**
 * Pretty-print sensitivity report.
 */
export function printSensitivityReport(report: SensitivityReport): void {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  SENSITIVITY ANALYSIS REPORT  [SIMULATED - MOCK PROVIDER]`);
  console.log(`${"=".repeat(70)}`);

  console.log(`\n  BASELINE:`);
  console.log(`    ML Recovery Rate:     ${(report.baseline.mlRecoveryRate * 100).toFixed(1)}%`);
  console.log(`    Rules Recovery Rate:  ${(report.baseline.rulesRecoveryRate * 100).toFixed(1)}%`);
  console.log(`    ML Lift:              +${report.baseline.mlLift.toFixed(1)}%`);

  console.log(`\n  PERTURBATIONS:`);
  console.log(`  ${"─".repeat(66)}`);
  console.log(`  ${"Name".padEnd(25)} ${"ML Rate".padStart(10)} ${"Rules Rate".padStart(12)} ${"ML Lift".padStart(10)}`);
  console.log(`  ${"─".repeat(66)}`);
  for (const p of report.perturbations) {
    console.log(`  ${p.name.padEnd(25)} ${(p.mlRecoveryRate * 100).toFixed(1).padStart(9)}% ${(p.rulesRecoveryRate * 100).toFixed(1).padStart(11)}% +${p.mlLift.toFixed(1).padStart(8)}%`);
  }

  console.log(`\n  STABILITY:`);
  console.log(`    ML Rate Range:     ${(report.stability.mlRateRange.min * 100).toFixed(1)}% — ${(report.stability.mlRateRange.max * 100).toFixed(1)}% (width: ${report.stability.mlRateRange.width}pp)`);
  console.log(`    Rules Rate Range:  ${(report.stability.rulesRateRange.min * 100).toFixed(1)}% — ${(report.stability.rulesRateRange.max * 100).toFixed(1)}% (width: ${report.stability.rulesRateRange.width}pp)`);
  console.log(`    STABLE:            ${report.stability.stable ? "YES (CI width < 5pp)" : "NO (CI width >= 5pp)"}`);

  console.log(`${"=".repeat(70)}\n`);
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const report = runSensitivityAnalysis();
  printSensitivityReport(report);
}
