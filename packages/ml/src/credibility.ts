/**
 * ARBITER Credibility Scoring Module
 *
 * Assesses transaction credibility using rule-based heuristics + ML signals.
 * Determines whether a failed payment event should be flagged for vendor
 * review or proceed directly to automated outreach.
 *
 * Risk levels:
 *   LOW      — Normal flow, dispatch outreach immediately
 *   MEDIUM   — Flag but proceed, include in next vendor digest
 *   HIGH     — Suppress outreach, notify vendor for approval
 *   CRITICAL — Quarantine, block all outreach, require human review
 */
import type { FailureClassId } from "@arbiter/core/decide";

export interface CredibilityCustomerProfile {
  totalAttempts: number;
  totalSuccesses: number;
  totalFailures: number;
  totalAmountPaise: number;
  flaggedAsSuspicious: boolean;
  riskScoreBp: number;
  createdAtUtc: string;
}

export interface CredibilityInput {
  /** Null for first-time customers with no profile */
  customerProfile: CredibilityCustomerProfile | null;
  failureClass: FailureClassId;
  amountPaise: number;
  mlProbability: number;
  mlAttributions: ReadonlyArray<{ feature: string; contribution: number }>;
  priorFailureAmountsPaise: number[];
  occurredAtUtc: string;
}

export interface CredibilityResult {
  /** 0..1 composite credibility score (1 = fully credible, 0 = certain fraud) */
  score: number;
  isSuspicious: boolean;
  reasons: string[];
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

function daysSince(isoDate: string, nowMs: number): number {
  const d = new Date(isoDate).getTime();
  return Math.max(0, (nowMs - d) / 86_400_000);
}

function computeRiskLevel(score: number): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  if (score >= 0.75) return "LOW";
  if (score >= 0.50) return "MEDIUM";
  if (score >= 0.25) return "HIGH";
  return "CRITICAL";
}

/**
 * Assess transaction credibility.
 *
 * Scoring model (0..1, higher = more credible):
 *   - Start at 0.80 (benef of the doubt)
 *   - First transaction:                      -0.15
 *   - High amount + zero success:             -0.20
 *   - RISK_FLAGGED by Razorpay:               -0.30
 *   - UNKNOWN failure on > ₹10k:             -0.15
 *   - ML probability > 0.7 (high recovery):   +0.10
 *   - ML probability < 0.3 (low recovery):    -0.10
 *   - Top attribution is risk-related:         -0.10
 *   - Account age < 1 day:                    -0.10
 *   - 3+ past failures, zero successes:       -0.15
 *   - Prior failure amounts show escalation:   -0.10
 *   Clamped to [0, 1].
 */
export function assessCredibility(input: CredibilityInput): CredibilityResult {
  const reasons: string[] = [];
  let score = 0.80;
  const nowMs = new Date(input.occurredAtUtc).getTime();

  // Rule 1: First transaction
  if (!input.customerProfile || input.customerProfile.totalAttempts === 0) {
    score -= 0.15;
    reasons.push("First transaction from this customer");
  } else {
    const cp = input.customerProfile;

    // Rule 2: High total attempted amount with zero successes
    if (cp.totalAmountPaise > 5_000_000 && cp.totalSuccesses === 0) {
      score -= 0.20;
      reasons.push("High total attempted amount (₹" + (cp.totalAmountPaise / 100).toLocaleString("en-IN") + ") with zero successes");
    }

    // Rule 3: Account age < 1 day
    const ageDays = daysSince(cp.createdAtUtc, nowMs);
    if (ageDays < 1) {
      score -= 0.10;
      reasons.push("Account created less than 24 hours ago");
    }

    // Rule 4: 3+ failures, zero successes
    if (cp.totalFailures >= 3 && cp.totalSuccesses === 0) {
      score -= 0.15;
      reasons.push(`${cp.totalFailures} failed attempts with zero successful payments`);
    }

    // Rule 5: Razorpay's own risk score elevated
    if (cp.riskScoreBp > 3000) {
      score -= 0.10;
      reasons.push("Razorpay risk score elevated (" + cp.riskScoreBp + " bp)");
    }
  }

  // Rule 6: RISK_FLAGGED by Razorpay
  if (input.failureClass === "RISK_FLAGGED") {
    score -= 0.30;
    reasons.push("Razorpay flagged this transaction as high-risk");
  }

  // Rule 7: UNKNOWN failure on high-value transaction
  if (input.failureClass === "UNKNOWN" && input.amountPaise > 1_000_000) {
    score -= 0.15;
    reasons.push("Unknown failure on high-value transaction (> ₹10,000)");
  }

  // ML signals
  // Rule 8: High recovery probability = more credible
  if (input.mlProbability > 0.7) {
    score += 0.10;
  }
  // Rule 9: Low recovery probability = less credible
  if (input.mlProbability < 0.3) {
    score -= 0.10;
    reasons.push("ML model assigns low recovery probability (" + (input.mlProbability * 100).toFixed(1) + "%)");
  }

  // Rule 10: Top attribution is risk-related
  const firstAttr = input.mlAttributions[0];
  if (firstAttr) {
    const topFeature = firstAttr.feature;
    if (topFeature === "f_class_risk" || topFeature === "f_is_risk_flagged") {
      score -= 0.10;
      reasons.push("ML top driver is risk-related feature (" + topFeature + ")");
    }
  }

  // Rule 11: Escalating failure amounts
  if (input.priorFailureAmountsPaise.length >= 2) {
    const sorted = [...input.priorFailureAmountsPaise].sort((a, b) => a - b);
    const minVal = sorted[0];
    const maxVal = sorted[sorted.length - 1];
    if (minVal !== undefined && maxVal !== undefined && maxVal > minVal * 2) {
      score -= 0.10;
      reasons.push("Failure amounts show escalation pattern");
    }
  }

  // Clamp
  score = Math.max(0, Math.min(1, score));

  const isSuspicious = score < 0.50;
  const riskLevel = computeRiskLevel(score);

  return { score, isSuspicious, reasons, riskLevel };
}

/**
 * Quick boolean check: should outreach be suppressed?
 */
export function isSuspicious(input: CredibilityInput): boolean {
  return assessCredibility(input).isSuspicious;
}
