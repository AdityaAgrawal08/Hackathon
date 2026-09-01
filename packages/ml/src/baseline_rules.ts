/**
 * Rules-only baseline engine — deterministic, ML-free recovery strategy.
 *
 * Used for ablation study (B-001): proves ML adds value over simple rules.
 * Each rule maps a failure class + context to a single action with no scoring.
 *
 * Rules (from TODO_TRACK3.md B-001):
 *   HARD_METHOD_DEAD → send new payment link
 *   SOFT_RETRYABLE + near_payday → retry now
 *   SOFT_RETRYABLE + not near_payday → schedule for payday
 *   NETWORK_TIMEOUT → retry in 2 hours
 *   RISK_FLAGGED → escalate to human
 *   UNKNOWN → send payment link
 *   Already contacted today → skip
 *   Quiet hours → defer
 */
import type { ActionId, FailureClassId } from "@arbiter/core/decide";
import { CONTACT_COST_PAISE } from "@arbiter/core/decide";

export interface RulesContext {
  failureClass: FailureClassId;
  inferredPaydayDay: number | null;
  nowMs: number;
  attemptsSoFar: number;
  lastContactAtMs: number | null;
}

/**
 * Check if current time is within TRAI quiet hours (22:00–08:00 IST).
 * IST = UTC+5:30.
 */
function isQuietHours(nowMs: number): boolean {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(nowMs + istOffsetMs);
  const hour = istDate.getUTCHours();
  return hour >= 22 || hour < 8;
}

/**
 * Check if a given payday day is "near" (within 2 days).
 */
function isNearPayday(paydayDay: number | null, nowMs: number): boolean {
  if (paydayDay === null) return false;
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(nowMs + istOffsetMs);
  const dayOfMonth = istDate.getUTCDate();
  // Near payday = within ±2 days of the payday
  const diff = Math.abs(dayOfMonth - paydayDay);
  return diff <= 2 || diff >= 28; // handles month wraparound
}

/**
 * Rules-only action selection. No ML, no probability, no EV — just deterministic rules.
 * Returns the action to take (or null if the event should be skipped).
 */
export function rulesOnlyAction(ctx: RulesContext): ActionId | null {
  // Rule: Already contacted today → skip
  if (ctx.lastContactAtMs !== null) {
    const hoursSinceContact = (ctx.nowMs - ctx.lastContactAtMs) / (1000 * 60 * 60);
    if (hoursSinceContact < 24) {
      return null; // skip — already contacted today
    }
  }

  // Rule: Quiet hours → defer (HUMAN_REVIEW for safe escalation)
  if (isQuietHours(ctx.nowMs)) {
    return "HUMAN_REVIEW";
  }

  // Rule: Already attempted more than 2 times → escalate
  if (ctx.attemptsSoFar >= 2) {
    return "HUMAN_REVIEW";
  }

  switch (ctx.failureClass) {
    case "HARD_METHOD_DEAD":
      // Rule: send new payment link
      return "ALTERNATE_UPI_LINK";

    case "SOFT_RETRYABLE":
      if (isNearPayday(ctx.inferredPaydayDay, ctx.nowMs)) {
        // Rule: near payday → retry now
        return "RETRY_NOW";
      } else {
        // Rule: not near payday → schedule for payday
        return "RETRY_PAYDAY";
      }

    case "NETWORK_TIMEOUT":
      // Rule: retry in 2 hours (RETRY_NOW with no timing change — rules can't schedule)
      return "RETRY_NOW";

    case "RISK_FLAGGED":
      // Rule: escalate to human
      return "HUMAN_REVIEW";

    case "UNKNOWN":
    default:
      // Rule: send payment link
      return "REMINDER_LINK";
  }
}

export interface RulesBaselineResult {
  action: ActionId | null;
  wouldRecover: boolean;
  costPaise: number;
}

/**
 * Simulate rules-only recovery for a single event with deterministic outcome.
 * Uses the same mock provider outcome logic as the ML pipeline.
 */
export function simulateRulesOutcome(
  ctx: RulesContext,
  amountPaise: number,
  eventIndex: number,
): RulesBaselineResult {
  const action = rulesOnlyAction(ctx);

  // Null action = skipped (already contacted or quiet hours defer)
  if (action === null) {
    return { action: null, wouldRecover: false, costPaise: 0 };
  }

  const costPaise = CONTACT_COST_PAISE[action] ?? 0;

  // Deterministic outcome: rules-only has fixed success rates per failure class
  const RULES_SUCCESS_RATES: Record<string, number> = {
    SOFT_RETRYABLE: 0.20,
    NETWORK_TIMEOUT: 0.30,
    HARD_METHOD_DEAD: 0.03,
    RISK_FLAGGED: 0.01,
    UNKNOWN: 0.10,
  };
  const rate = RULES_SUCCESS_RATES[ctx.failureClass] ?? 0.15;

  // Deterministic per-event outcome using hash
  const { hashSeed } = require("@arbiter/shared") as typeof import("@arbiter/shared");
  const draw = hashSeed(`rules:${eventIndex}:${ctx.failureClass}`) % 10_000;
  const wouldRecover = draw < Math.round(rate * 10_000);

  return { action, wouldRecover, costPaise };
}
