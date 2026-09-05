import type { Client } from "@libsql/client";
import { formatINR, paise } from "@arbiter/shared";
import type { HistoricalPaymentRecord } from "./historical_dataset.js";

export interface TargetPolicyDecision {
  action: string;
  probability: number;
}

export interface PolicyEvaluator {
  (record: HistoricalPaymentRecord): TargetPolicyDecision;
}

export interface OPEResult {
  policyName: string;
  evaluatedCount: number;
  effectiveSampleSize: number;
  recoveredGmvPaise: number;
  totalAtRiskPaise: number;
  recoveryRatePercent: number;
  ci95LowPercent: number;
  ci95HighPercent: number;
  ipsEstimate: number;
  directMethodEstimate: number;
  doublyRobustEstimate: number;
  liftVsControlPercent?: number;
  liftVsRulesPercent?: number;
  mdrSavingsPaise: number;
  formattedRecoveredGmv: string;
}

export interface OPEBenchmarkReport {
  datasetSize: number;
  totalAtRiskPaise: number;
  formattedTotalAtRisk: string;
  policies: {
    control: OPEResult;
    naiveRetry: OPEResult;
    staticRules: OPEResult;
    arbiterAgent: OPEResult;
  };
  liftVsControlPaise: number;
  liftVsRulesPaise: number;
  formattedLiftVsControl: string;
  formattedLiftVsRules: string;
  methodology: "DOUBLY_ROBUST_OFF_POLICY_EVALUATION";
}

function extractFeatures(record: HistoricalPaymentRecord): number[] {
  const normAmount = Math.min(1.0, record.amountPaise / 1000000);
  const isTech = record.failureCategory === "TECHNICAL" ? 1.0 : 0.0;
  const isUser = record.failureCategory === "USER_ACTIONABLE" ? 1.0 : 0.0;
  const isLiq = record.failureCategory === "LIQUIDITY" ? 1.0 : 0.0;
  const isCard = record.isCard ? 1.0 : 0.0;
  const priorSucc = Math.min(1.0, record.priorSuccessCount / 5);
  return [1.0, normAmount, isTech, isUser, isLiq, isCard, priorSucc];
}

class RidgeRewardModel {
  private weights: Map<string, number[]> = new Map();

  fit(records: readonly HistoricalPaymentRecord[]): void {
    const actionGroups = new Map<string, { X: number[][]; Y: number[] }>();

    for (const r of records) {
      const action = r.actionTaken;
      if (!actionGroups.has(action)) {
        actionGroups.set(action, { X: [], Y: [] });
      }
      const group = actionGroups.get(action)!;
      group.X.push(extractFeatures(r));
      group.Y.push(r.recovered ? 1.0 : 0.0);
    }

    for (const [action, group] of actionGroups.entries()) {
      const dim = 7;
      const XtX = Array.from({ length: dim }, () => new Array(dim).fill(0));
      const XtY = new Array(dim).fill(0);
      const lambda = 1.0;

      for (let i = 0; i < group.X.length; i++) {
        const x = group.X[i]!;
        const y = group.Y[i]!;
        for (let j = 0; j < dim; j++) {
          XtY[j] += x[j]! * y;
          for (let k = 0; k < dim; k++) {
            XtX[j]![k]! += x[j]! * x[k]!;
          }
        }
      }

      for (let d = 0; d < dim; d++) {
        XtX[d]![d]! += lambda;
      }

      const w = this.solveLinear(XtX, XtY, dim);
      this.weights.set(action, w);
    }
  }

  predict(record: HistoricalPaymentRecord, action: string): number {
    const w = this.weights.get(action);
    if (!w) return 0.20;
    const x = extractFeatures(record);
    let dot = 0;
    for (let i = 0; i < x.length; i++) {
      dot += (x[i] ?? 0) * (w[i] ?? 0);
    }
    return Math.max(0.01, Math.min(0.99, dot));
  }

  private solveLinear(A: number[][], b: number[], n: number): number[] {
    const M = A.map((row, i) => [...row, b[i]!]);
    for (let i = 0; i < n; i++) {
      let maxRow = i;
      for (let k = i + 1; k < n; k++) {
        if (Math.abs(M[k]![i]!) > Math.abs(M[maxRow]![i]!)) maxRow = k;
      }
      const tmp = M[i]!;
      M[i] = M[maxRow]!;
      M[maxRow] = tmp;

      const pivot = M[i]![i]! || 1e-6;
      for (let j = i; j <= n; j++) {
        M[i]![j] = M[i]![j]! / pivot;
      }
      for (let k = 0; k < n; k++) {
        if (k !== i) {
          const factor = M[k]![i]!;
          for (let j = i; j <= n; j++) {
            M[k]![j] = M[k]![j]! - factor * M[i]![j]!;
          }
        }
      }
    }
    return M.map((row) => row[n]!);
  }
}

export function evaluatePolicyDoublyRobust(
  policyName: string,
  records: readonly HistoricalPaymentRecord[],
  policy: PolicyEvaluator,
  rewardModel?: RidgeRewardModel,
  maxWeightClip: number = 20.0,
): OPEResult {
  const n = records.length;
  if (n === 0) {
    throw new Error("Cannot evaluate policy on empty records.");
  }

  const model = rewardModel ?? (() => {
    const rm = new RidgeRewardModel();
    rm.fit(records);
    return rm;
  })();


  let totalAtRiskPaise = 0;
  let sumIps = 0;
  let sumDm = 0;
  let sumDr = 0;

  const drValues: number[] = [];
  const weights: number[] = [];
  let mdrSavingsPaise = 0;

  for (const r of records) {
    totalAtRiskPaise += r.amountPaise;

    const decision = policy(r);
    const targetAction = decision.action;
    const pi_a = decision.probability;

    const isMatch = r.actionTaken === targetAction;
    const p0 = Math.max(0.01, r.loggingPropensity);
    const rawWeight = isMatch ? pi_a / p0 : 0.0;
    const w = Math.min(rawWeight, maxWeightClip);
    weights.push(w);

    const Y = r.recovered ? 1.0 : 0.0;
    const q_target = model.predict(r, targetAction);
    const q_observed = model.predict(r, r.actionTaken);

    const ipsVal = w * Y;
    const dmVal = q_target;
    const drVal = q_target + w * (Y - q_observed);

    sumIps += ipsVal;
    sumDm += dmVal;
    sumDr += drVal;
    drValues.push(drVal);

    if (r.isCard && (targetAction.includes("UPI") || targetAction.includes("1TAP"))) {
      mdrSavingsPaise += Math.round(r.amountPaise * 0.0175 * Math.max(0, drVal));
    }
  }

  const ipsEstimate = sumIps / n;
  const dmEstimate = sumDm / n;
  const drEstimate = Math.max(0.0, Math.min(1.0, sumDr / n));

  let sumW = 0;
  let sumW2 = 0;
  for (const w of weights) {
    sumW += w;
    sumW2 += w * w;
  }
  const ess = sumW2 > 0 ? (sumW * sumW) / sumW2 : n;

  const B = 500;
  const bootEstimates: number[] = [];
  for (let b = 0; b < B; b++) {
    let bSum = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(Math.random() * n);
      bSum += drValues[idx] ?? 0;
    }
    bootEstimates.push(bSum / n);
  }
  bootEstimates.sort((a, b) => a - b);
  const ciLow = Number((Math.max(0, (bootEstimates[Math.floor(B * 0.025)] ?? 0)) * 100).toFixed(1));
  const ciHigh = Number((Math.min(1.0, (bootEstimates[Math.floor(B * 0.975)] ?? 0)) * 100).toFixed(1));

  const recoveredGmvPaise = Math.round(totalAtRiskPaise * drEstimate);
  const recoveryRatePercent = Number((drEstimate * 100).toFixed(1));

  return {
    policyName,
    evaluatedCount: n,
    effectiveSampleSize: Math.round(ess),
    recoveredGmvPaise,
    totalAtRiskPaise,
    recoveryRatePercent,
    ci95LowPercent: ciLow,
    ci95HighPercent: ciHigh,
    ipsEstimate: Number(ipsEstimate.toFixed(4)),
    directMethodEstimate: Number(dmEstimate.toFixed(4)),
    doublyRobustEstimate: Number(drEstimate.toFixed(4)),
    mdrSavingsPaise,
    formattedRecoveredGmv: formatINR(paise(recoveredGmvPaise)),
  };
}

export function evaluateAllPoliciesCounterfactually(
  records: readonly HistoricalPaymentRecord[],
): OPEBenchmarkReport {
  const rewardModel = new RidgeRewardModel();
  rewardModel.fit(records);

  const controlPolicy: PolicyEvaluator = () => ({
    action: "NO_ACTION",
    probability: 1.0,
  });

  const naiveRetryPolicy: PolicyEvaluator = () => ({
    action: "GATEWAY_RETRY",
    probability: 1.0,
  });

  const staticRulesPolicy: PolicyEvaluator = (r) => {
    if (r.failureCategory === "TECHNICAL") {
      return { action: "GATEWAY_RETRY", probability: 0.90 };
    }
    return { action: "DUAL_CHANNEL_REMINDER", probability: 0.90 };
  };

  const arbiterAgentPolicy: PolicyEvaluator = (r) => {
    if (r.isCard) {
      return { action: "1TAP_UPI_LINK", probability: 0.95 };
    }
    if (r.failureCategory === "USER_ACTIONABLE") {
      return { action: "SMS_1TAP_UPI", probability: 0.95 };
    }
    if (r.failureCategory === "LIQUIDITY") {
      return { action: "1TAP_UPI_LINK", probability: 0.85 };
    }
    return { action: "GATEWAY_RETRY", probability: 0.80 };
  };

  const controlRes = evaluatePolicyDoublyRobust("Control Baseline (Zero Outreach)", records, controlPolicy, rewardModel);
  const naiveRes = evaluatePolicyDoublyRobust("Blind Gateway Retries", records, naiveRetryPolicy, rewardModel);
  const rulesRes = evaluatePolicyDoublyRobust("Static 7-Rule Heuristics", records, staticRulesPolicy, rewardModel);
  const arbiterRes = evaluatePolicyDoublyRobust("ARBITER Autonomous Agent", records, arbiterAgentPolicy, rewardModel);

  arbiterRes.liftVsControlPercent = Number((arbiterRes.recoveryRatePercent - controlRes.recoveryRatePercent).toFixed(1));
  arbiterRes.liftVsRulesPercent = Number((arbiterRes.recoveryRatePercent - rulesRes.recoveryRatePercent).toFixed(1));

  const totalAtRisk = controlRes.totalAtRiskPaise;
  const liftVsControlPaise = Math.max(0, arbiterRes.recoveredGmvPaise - controlRes.recoveredGmvPaise);
  const liftVsRulesPaise = Math.max(0, arbiterRes.recoveredGmvPaise - rulesRes.recoveredGmvPaise);

  return {
    datasetSize: records.length,
    totalAtRiskPaise: totalAtRisk,
    formattedTotalAtRisk: formatINR(paise(totalAtRisk)),
    policies: {
      control: controlRes,
      naiveRetry: naiveRes,
      staticRules: rulesRes,
      arbiterAgent: arbiterRes,
    },
    liftVsControlPaise,
    liftVsRulesPaise,
    formattedLiftVsControl: formatINR(paise(liftVsControlPaise)),
    formattedLiftVsRules: formatINR(paise(liftVsRulesPaise)),
    methodology: "DOUBLY_ROBUST_OFF_POLICY_EVALUATION",
  };
}

/**
 * Loads real payment events from database into HistoricalPaymentRecord format for OPE counterfactual evaluation.
 */
export async function loadHistoricalRecordsFromDb(
  client: Client,
  limit: number = 1000,
): Promise<HistoricalPaymentRecord[]> {
  try {
    const res = await client.execute({
      sql: `SELECT lpe.*, cp.prior_success_count, cp.prior_failure_count
            FROM live_payment_events lpe
            LEFT JOIN customer_profiles cp ON cp.id = lpe.customer_profile_id
            ORDER BY lpe.created_at_utc DESC
            LIMIT ?`,
      args: [limit],
    });

    return res.rows.map((row: any) => {
      const code = String(row.failure_code || "UNKNOWN");
      const isCard = String(row.payment_method || "").toLowerCase().includes("card");
      const method = (row.payment_method || (isCard ? "card" : "upi")) as any;
      const isRecovered = row.status === "captured" || row.status === "recovered";

      let failureCategory: HistoricalPaymentRecord["failureCategory"] = "USER_ACTIONABLE";
      if (code.includes("GATEWAY") || code.includes("TIMEOUT") || code.includes("ISSUER_DOWN") || code.includes("NETWORK")) {
        failureCategory = "TECHNICAL";
      } else if (code.includes("INSUFFICIENT") || code.includes("LIMIT")) {
        failureCategory = "LIQUIDITY";
      } else if (code.includes("EXPIRED") || code.includes("INVALID")) {
        failureCategory = "EXPIRED_METHOD";
      }

      return {
        paymentId: String(row.id),
        orderId: String(row.razorpay_order_id || row.id),
        amountPaise: Number(row.amount_paise) || 100000,
        occurredAtUtc: String(row.created_at_utc),
        failureCode: code,
        failureDescription: String(row.failure_description || ""),
        failureCategory,
        method: method === "card" || method === "upi" || method === "netbanking" || method === "wallet" ? method : "upi",
        isCard,
        issuerBank: String(row.card_issuer || row.bank_code || "HDFC"),
        customerTier: Number(row.amount_paise) >= 500000 ? "HIGH_VALUE" : "STANDARD",
        priorSuccessCount: Number(row.prior_success_count) || 0,
        priorFailureCount: Number(row.prior_failure_count) || 0,
        loggingPolicy: "HISTORICAL_AGENT",
        actionTaken: String(row.bandit_action || row.ml_action || "1TAP_UPI_LINK"),
        loggingPropensity: 0.85,
        recovered: isRecovered,
        recoveryRail: isRecovered ? "UPI" : undefined,
      };
    });
  } catch {
    return [];
  }
}

