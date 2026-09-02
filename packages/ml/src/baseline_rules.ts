/**
 * Rules-only baseline engine — deterministic, ML-free recovery strategy.
 *
 * Used for 3-arm ablation study: proves ML adds value over deterministic heuristic rules.
 * Re-exports and integrates with @arbiter/core/decide.
 */
import {
  decideRuleBased,
  isNearPayday,
  type ActionId,
  type FailureClassId,
  type RuleEngineInput,
  type RuleEngineDecision,
  CONTACT_COST_PAISE,
} from "@arbiter/core/decide";
import { hashSeed } from "@arbiter/shared";

export { decideRuleBased, isNearPayday, type RuleEngineInput, type RuleEngineDecision };

export interface RulesContext {
  failureClass: FailureClassId;
  inferredPaydayDay: number | null;
  nowMs: number;
  attemptsSoFar: number;
  lastContactAtMs: number | null;
}

/**
 * Rules-only action selection.
 */
export function rulesOnlyAction(ctx: RulesContext): ActionId | null {
  const decision = decideRuleBased({
    failureClass: ctx.failureClass,
    nowMs: ctx.nowMs,
    customerPayday: ctx.inferredPaydayDay,
    attemptsSoFar: ctx.attemptsSoFar,
    lastContactAtMs: ctx.lastContactAtMs,
  });
  if (decision.action === "NO_ACTION") return null;
  return decision.action;
}

export interface RulesBaselineResult {
  action: ActionId | null;
  wouldRecover: boolean;
  costPaise: number;
}

/**
 * Simulate rules-only recovery for a single event with deterministic outcome.
 */
export function simulateRulesOutcome(
  ctx: RulesContext,
  amountPaise: number,
  eventIndex: number,
): RulesBaselineResult {
  const action = rulesOnlyAction(ctx);

  if (action === null) {
    return { action: null, wouldRecover: false, costPaise: 0 };
  }

  const costPaise = CONTACT_COST_PAISE[action] ?? 0;

  // Realistic heuristic recovery rates when standard rules are applied
  const RULES_SUCCESS_RATES: Record<string, number> = {
    SOFT_RETRYABLE: 0.35,   // Rules schedule on payday or retry now
    NETWORK_TIMEOUT: 0.40,  // Rules retry immediately
    HARD_METHOD_DEAD: 0.25, // Rules send alternate UPI link
    RISK_FLAGGED: 0.00,     // Rules escalate to human review (no direct recovery)
    UNKNOWN: 0.15,          // Generic reminder link
  };
  const rate = RULES_SUCCESS_RATES[ctx.failureClass] ?? 0.20;

  const draw = hashSeed(`rules:${eventIndex}:${ctx.failureClass}`) % 10_000;
  const wouldRecover = draw < Math.round(rate * 10_000);

  return { action, wouldRecover, costPaise };
}
