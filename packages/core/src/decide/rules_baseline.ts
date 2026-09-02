/**
 * Deterministic 7-Rule Heuristic Baseline Engine (RULE-01).
 *
 * Represents standard dunning and recovery heuristics commonly deployed in
 * industry PSPs and subscription platforms. Used for empirical 3-arm ablation
 * benchmarks to prove the marginal lift of ARBITER's 22-D ML + EV Decision Engine.
 */
import type { ActionId, FailureClassId } from "./catalog.js";
import { isQuietHoursIST } from "./window.js";

export interface RuleEngineInput {
  failureClass: FailureClassId;
  occurredAtUtc?: string;
  nowMs: number;
  customerPayday?: number | null;
  attemptsSoFar?: number;
  lastContactAtMs?: number | null;
}

export interface RuleEngineDecision {
  action: ActionId;
  rationale: string;
  isContactAction: boolean;
  deferredDueToQuietHours?: boolean;
}

/**
 * Check if a given payday day is within ±2 days of current date (handles month wraparound).
 */
export function isNearPayday(paydayDay: number | null | undefined, nowMs: number): boolean {
  if (paydayDay === null || paydayDay === undefined || !Number.isFinite(paydayDay)) return false;
  const istOffsetMs = 5.5 * 3_600_000;
  const istDate = new Date(nowMs + istOffsetMs);
  const dayOfMonth = istDate.getUTCDate();
  const diff = Math.abs(dayOfMonth - paydayDay);
  return diff <= 2 || diff >= 28;
}

/**
 * Deterministic rule-based recovery decision.
 * Evaluates the 7 heuristic rules in strict order of precedence.
 */
export function decideRuleBased(input: RuleEngineInput): RuleEngineDecision {
  const attempts = input.attemptsSoFar ?? 0;
  const nowMs = input.nowMs;

  // Rule 1: TRAI Quiet Hours Guard (21:00 to 09:00 IST)
  if (isQuietHoursIST(nowMs)) {
    return {
      action: "HUMAN_REVIEW",
      rationale: "Rule 1: TRAI quiet hours active (21:00-09:00 IST) — defer outreach",
      isContactAction: false,
      deferredDueToQuietHours: true,
    };
  }

  // Rule 2: Max Attempts Cap (fail-safe to prevent customer harassment)
  if (attempts >= 2) {
    return {
      action: "HUMAN_REVIEW",
      rationale: "Rule 2: Retry attempts exhausted (>=2) — escalate to human review",
      isContactAction: false,
    };
  }

  // Rule 3: Minimum Contact Interval (skip if contacted within last 24 hours)
  if (input.lastContactAtMs !== null && input.lastContactAtMs !== undefined) {
    const hoursSinceLastContact = (nowMs - input.lastContactAtMs) / (1000 * 3600);
    if (hoursSinceLastContact < 24) {
      return {
        action: "NO_ACTION",
        rationale: "Rule 3: Minimum contact interval not met (<24h since last outreach)",
        isContactAction: false,
      };
    }
  }

  // Domain Rules based on Failure Classification
  switch (input.failureClass) {
    case "HARD_METHOD_DEAD":
      // Rule 4: Dead card/method -> send alternate payment link immediately
      return {
        action: "ALTERNATE_UPI_LINK",
        rationale: "Rule 4: Payment method dead (expired/closed) — prompt customer with alternate UPI link",
        isContactAction: true,
      };

    case "SOFT_RETRYABLE": {
      // Rule 5: Insufficient funds -> check payday timing
      const nearPayday = isNearPayday(input.customerPayday, nowMs);
      if (nearPayday) {
        return {
          action: "RETRY_NOW",
          rationale: "Rule 5a: Soft decline near payday (±2 days) — immediate retry",
          isContactAction: true,
        };
      }
      return {
        action: "RETRY_PAYDAY",
        rationale: "Rule 5b: Soft decline mid-month — schedule retry on salary date",
        isContactAction: true,
      };
    }

    case "NETWORK_TIMEOUT":
      // Rule 6: Bank/gateway timeout -> retry now after transient buffer
      return {
        action: "RETRY_NOW",
        rationale: "Rule 6: Transient network timeout — retry on payment rail",
        isContactAction: true,
      };

    case "RISK_FLAGGED":
      // Rule 7: Fraud/risk flagged -> strictly escalate to human review
      return {
        action: "HUMAN_REVIEW",
        rationale: "Rule 7: Risk/fraud alert detected — escalate to merchant compliance team",
        isContactAction: false,
      };

    case "UNKNOWN":
    default:
      return {
        action: "REMINDER_LINK",
        rationale: "Default Rule: Unclassified failure — dispatch standard recovery reminder",
        isContactAction: true,
      };
  }
}
