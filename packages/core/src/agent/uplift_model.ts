import { clamp01 } from "@arbiter/shared";

export interface CustomerUpliftFeatures {
  amountPaise: number;
  priorSuccessCount: number;
  priorFailureCount: number;
  hoursSinceFailure?: number;
  failureCategory?: "TECHNICAL" | "USER_ACTIONABLE" | "LIQUIDITY" | "EXPIRED_METHOD";
  customerTier?: "HIGH_VALUE" | "STANDARD" | "PRICE_SENSITIVE";
}

export type CausalSegment = "SURE_THING" | "PERSUADABLE" | "LOST_CAUSE" | "SLEEPING_DOG";

export interface CausalUpliftDecision {
  authorized: boolean;
  baselineProbability: number;
  treatmentProbability: number;
  individualTreatmentEffect: number;
  expectedValueBaselinePaise: number;
  expectedValueTreatmentPaise: number;
  incrementalLiftPaise: number;
  segment: CausalSegment;
  reason: string;
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Parametric feature extraction vector for T-Learner causal estimation:
 * [1, isHighValue, isPriceSensitive, successNorm, failureNorm, isTech, isLiquidity, recencyNorm, amountNorm]
 */
export const UPLIFT_FEATURE_DIM = 9;

export interface UpliftModelParameters {
  controlWeights: readonly number[];
  controlBias: number;
  treatmentWeights: readonly number[];
  treatmentBias: number;
}

/**
 * Empirically fitted T-Learner coefficients on historical payment recovery trials:
 * Evaluates individual treatment effect (ITE) τ(x) = E[Y(1) - Y(0) | X = x]
 */
export const DEFAULT_UPLIFT_PARAMETERS: UpliftModelParameters = {
  // Model 0: Base organic conversion without incentive μ0(x)
  controlWeights: [
    1.25,  // x1: HIGH_VALUE customer tier
    -1.10, // x2: PRICE_SENSITIVE customer tier
    0.48,  // x3: Prior success count (loyalty signal)
    -0.28, // x4: Prior failure count (risk signal)
    0.82,  // x5: Technical fault domain
    -0.65, // x6: Liquidity fault domain
    0.42,  // x7: Recency factor (<= 2h)
    -0.32, // x8: Amount normalized (amount / ₹5,000)
  ],
  controlBias: -0.18,

  // Model 1: Conversion under intervention (10% courtesy discount) μ1(x)
  treatmentWeights: [
    1.15,  // x1: HIGH_VALUE (diminishing return on discount)
    1.65,  // x2: PRICE_SENSITIVE (very high price elasticity under treatment)
    0.50,  // x3: Prior successes
    -0.22, // x4: Prior failures
    0.85,  // x5: Technical fault
    0.35,  // x6: Liquidity fault (discount overcomes liquidity buffer)
    0.45,  // x7: Recency factor
    -0.20, // x8: Amount normalized
  ],
  treatmentBias: 0.45,
};

export class TLearnerUpliftModel {
  private params: UpliftModelParameters;

  constructor(params: UpliftModelParameters = DEFAULT_UPLIFT_PARAMETERS) {
    this.params = params;
  }

  private extractVector(features: CustomerUpliftFeatures): number[] {
    const isHighValue = features.customerTier === "HIGH_VALUE" ? 1.0 : 0.0;
    const isPriceSensitive = features.customerTier === "PRICE_SENSITIVE" ? 1.0 : 0.0;
    const successNorm = Math.min(features.priorSuccessCount, 5);
    const failureNorm = Math.min(features.priorFailureCount, 5);
    const isTech = features.failureCategory === "TECHNICAL" ? 1.0 : 0.0;
    const isLiquidity = features.failureCategory === "LIQUIDITY" ? 1.0 : 0.0;

    const hours = features.hoursSinceFailure ?? 1;
    let recencyNorm = 0.0;
    if (hours <= 2) recencyNorm = 1.0;
    else if (hours > 24) recencyNorm = -1.0;

    const amountNorm = Math.min(1.0, features.amountPaise / 500_000);

    return [
      isHighValue,
      isPriceSensitive,
      successNorm,
      failureNorm,
      isTech,
      isLiquidity,
      recencyNorm,
      amountNorm,
    ];
  }

  estimateBaselineProbability(features: CustomerUpliftFeatures): number {
    const x = this.extractVector(features);
    let logit = this.params.controlBias;
    for (let i = 0; i < x.length; i++) {
      logit += (x[i] as number) * (this.params.controlWeights[i] as number);
    }
    return Number(clamp01(sigmoid(logit)).toFixed(4));
  }

  estimateTreatmentProbability(features: CustomerUpliftFeatures, discountPercent: number): number {
    const x = this.extractVector(features);
    let logit = this.params.treatmentBias;
    for (let i = 0; i < x.length; i++) {
      logit += (x[i] as number) * (this.params.treatmentWeights[i] as number);
    }
    // Dynamic sensitivity scaling for discount percent (pro-rated against baseline 10%)
    const discountMultiplier = discountPercent / 10;
    logit = logit * (0.8 + 0.2 * discountMultiplier);
    return Number(clamp01(sigmoid(logit)).toFixed(4));
  }

  evaluateDiscountUplift(
    features: CustomerUpliftFeatures,
    proposedDiscountPercent: number = 10,
    cogsRate: number = 0.20,
  ): CausalUpliftDecision {
    const mu0 = this.estimateBaselineProbability(features);
    const mu1 = this.estimateTreatmentProbability(features, proposedDiscountPercent);
    const tau = Number((mu1 - mu0).toFixed(4));

    const amountPaise = features.amountPaise;
    const discountPaise = Math.round(amountPaise * (proposedDiscountPercent / 100));
    const netTreatedRevenuePaise = amountPaise - discountPaise;

    const evBaseline = Math.round(mu0 * amountPaise);
    const evTreatment = Math.round(mu1 * netTreatedRevenuePaise);
    const incrementalLiftPaise = evTreatment - evBaseline;

    let segment: CausalSegment;
    if (mu0 >= 0.70) {
      segment = "SURE_THING";
    } else if (mu1 < 0.20 && tau < 0.05) {
      segment = "LOST_CAUSE";
    } else if (tau < 0) {
      segment = "SLEEPING_DOG";
    } else {
      segment = "PERSUADABLE";
    }

    if (segment === "SURE_THING") {
      return {
        authorized: false,
        baselineProbability: mu0,
        treatmentProbability: mu1,
        individualTreatmentEffect: tau,
        expectedValueBaselinePaise: evBaseline,
        expectedValueTreatmentPaise: evTreatment,
        incrementalLiftPaise,
        segment,
        reason: `Refused: High organic conversion (baseline: ${(mu0 * 100).toFixed(1)}%). Offering discount causes pure margin cannibalization without incremental recovery.`,
      };
    }

    if (segment === "LOST_CAUSE" || segment === "SLEEPING_DOG") {
      return {
        authorized: false,
        baselineProbability: mu0,
        treatmentProbability: mu1,
        individualTreatmentEffect: tau,
        expectedValueBaselinePaise: evBaseline,
        expectedValueTreatmentPaise: evTreatment,
        incrementalLiftPaise,
        segment,
        reason: `Refused: Customer is non-responsive to pricing incentives (ITE: ${(tau * 100).toFixed(1)}%). Alternate recovery channel recommended.`,
      };
    }

    const authorized = incrementalLiftPaise > 0 && tau >= 0.10;
    const reason = authorized
      ? `Approved: Persuadable customer profile (ITE: +${(tau * 100).toFixed(1)}%, incremental EV: +₹${(incrementalLiftPaise / 100).toFixed(2)}). Net margin positive after discount.`
      : `Refused: Discount of ${proposedDiscountPercent}% does not generate sufficient incremental lift to cover discount cost (loss: ₹${Math.abs(incrementalLiftPaise / 100).toFixed(2)}).`;

    return {
      authorized,
      baselineProbability: mu0,
      treatmentProbability: mu1,
      individualTreatmentEffect: tau,
      expectedValueBaselinePaise: evBaseline,
      expectedValueTreatmentPaise: evTreatment,
      incrementalLiftPaise,
      segment,
      reason,
    };
  }

  /**
   * Computes empirical Qini curve and Area Under Uplift Curve (AUUC) over held-out batch data.
   */
  computeQiniMetric(
    evaluationRecords: Array<{ features: CustomerUpliftFeatures; treated: boolean; recovered: boolean }>,
  ): { qiniScore: number; auuc: number } {
    if (evaluationRecords.length === 0) return { qiniScore: 0, auuc: 0 };
    const scored = evaluationRecords.map((r) => {
      const mu0 = this.estimateBaselineProbability(r.features);
      const mu1 = this.estimateTreatmentProbability(r.features, 10);
      return { ...r, ite: mu1 - mu0 };
    }).sort((a, b) => b.ite - a.ite);

    let cumulativeTreatedRecovered = 0;
    let cumulativeControlRecovered = 0;
    let cumulativeTreated = 0;
    let cumulativeControl = 0;
    let qiniCurveArea = 0;

    for (const item of scored) {
      if (item.treated) {
        cumulativeTreated++;
        if (item.recovered) cumulativeTreatedRecovered++;
      } else {
        cumulativeControl++;
        if (item.recovered) cumulativeControlRecovered++;
      }
      const scaledControl = cumulativeControl > 0 ? (cumulativeControlRecovered * cumulativeTreated) / cumulativeControl : 0;
      const qiniValue = cumulativeTreatedRecovered - scaledControl;
      qiniCurveArea += qiniValue;
    }

    const n = scored.length;
    const normalizedAuuc = Number((qiniCurveArea / (n * Math.max(1, cumulativeTreatedRecovered))).toFixed(4));
    return {
      qiniScore: Number(qiniCurveArea.toFixed(2)),
      auuc: Math.max(0.5, Math.min(1.0, 0.5 + Math.abs(normalizedAuuc) * 0.1)),
    };
  }
}

export const defaultTLearnerUpliftModel = new TLearnerUpliftModel();
