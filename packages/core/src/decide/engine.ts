import {
  ACTIONS,
  CONTACT_COST_PAISE,
  isContactAction,
  multiplierFor,
  type ActionId,
  type FailureClassId,
  type Multipliers,
} from "./catalog.js";
import { evaluateConstraints, type PolicyPack, type RuleId } from "./policy.js";
import {
  nextPaydayWindowMs,
  nextRailHealthyWindowMs,
  RAIL_HEALTH_THRESHOLD,
  RAIL_DEPENDENT_ACTIONS,
} from "./window.js";
import { formatINR, paise, percentBp, LTV_NORM_PAISE } from "@arbiter/shared";

export interface DecideInput {
  probability: number;
  failureClass: FailureClassId;
  amountPaise: number;
  nowMs: number;
  policy: PolicyPack;
  attemptsSoFar?: number;
  lastContactAtMs?: number | null;
  customerOptedOut?: boolean;
  multipliers?: Multipliers;
  inferredPaydayDay?: number | null;
  /** Estimated lifetime value (paise). When supplied, EV is LTV-weighted. */
  ltvPaise?: number;
  /** Predicted churn risk in basis points (0..10000). */
  churnRiskBp?: number;
  /** Overall payment-rail health (0..1). When < threshold, rail-dependent
   *  actions are deferred to the next healthy window (§4.5). Opt-in. */
  railHealthScore?: number;
}

/**
 * LTV weight for the EV calculation (§4.4). A per-customer scalar in [0.2, 1.5]:
 * high-LTV / low-churn customers are worth more aggressive recovery;
 * low-LTV / high-churn customers are de-prioritized so we don't spend a
 * ₹50 human touch chasing a ₹49 soon-to-churn customer.
 * When LTV signals are absent the weight is 1 (backward compatible).
 */
export function ltvWeight(ltvPaise?: number, churnRiskBp?: number): number {
  if (ltvPaise == null || churnRiskBp == null) return 1;
  const ltvScore = clamp01(ltvPaise / LTV_NORM_PAISE);
  const churn = clamp01(churnRiskBp / 10_000);
  return clamp(1.0 + 0.5 * ltvScore - 0.7 * churn, 0.2, 1.5);
}

export interface RankedAction {
  action: ActionId;
  evPaise: number;
  adjustedProbabilityBp: number;
  multiplierUsed: number;
  scheduledForMs: number | null;
}

export interface RefusalRecord {
  action: ActionId;
  violatedRules: RuleId[];
}

export interface DecideOutput {
  ranked: RankedAction[];
  chosen: RankedAction;
  refusals: RefusalRecord[];
  fallbackReason: string | null;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function scheduleFor(action: ActionId, input: DecideInput): number | null {
  if (action === "RETRY_NOW") return input.nowMs;
  if (action === "RETRY_PAYDAY") {
    const raw = input.inferredPaydayDay;
    const day =
      typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 31 ? raw : null;
    return day !== null ? nextPaydayWindowMs(day, input.nowMs) : null;
  }
  return null;
}

/**
 * Rail-health-aware scheduling (§4.5): a rail-dependent action attempted while
 * the rail is degraded is deferred to the next healthy window instead of
 * wasting an attempt. Healthy rail → unchanged schedule. Opt-in (only when
 * `railHealthScore` is supplied).
 */
function scheduleWithRailHealth(action: ActionId, input: DecideInput): number | null {
  let scheduled = scheduleFor(action, input);
  if (
    input.railHealthScore != null &&
    RAIL_DEPENDENT_ACTIONS.has(action) &&
    input.railHealthScore < RAIL_HEALTH_THRESHOLD
  ) {
    scheduled = nextRailHealthyWindowMs(input.railHealthScore, input.nowMs);
  }
  return scheduled;
}

function evaluateAction(
  input: DecideInput,
  action: ActionId,
): { ev: RankedAction; violations: RuleId[] } {
  const mult = multiplierFor(input.failureClass, action, input.multipliers);
  const pBp = Math.round(clamp01(input.probability * mult) * 10_000);
  const amount = paise(input.amountPaise);

  const ctx = {
    failureClass: input.failureClass,
    amountPaise: input.amountPaise,
    probabilityBp: pBp,
    nowMs: input.nowMs,
    attemptsSoFar: input.attemptsSoFar ?? 0,
    lastContactAtMs: input.lastContactAtMs ?? null,
    customerOptedOut: input.customerOptedOut ?? false,
    isContactAction: isContactAction(action),
    paydayKnown:
      action !== "RETRY_PAYDAY" ||
      (typeof input.inferredPaydayDay === "number" &&
        Number.isInteger(input.inferredPaydayDay) &&
        input.inferredPaydayDay >= 1 &&
        input.inferredPaydayDay <= 31),
    actionId: action,
  };
  const violations = evaluateConstraints(input.policy, ctx);

  const gross = Math.round(percentBp(amount, pBp) * ltvWeight(input.ltvPaise, input.churnRiskBp));
  const ev: RankedAction = {
    action,
    evPaise: gross - CONTACT_COST_PAISE[action],
    adjustedProbabilityBp: pBp,
    multiplierUsed: mult,
    scheduledForMs: violations.length === 0 ? scheduleWithRailHealth(action, input) : null,
  };
  return { ev, violations };
}

export function decide(input: DecideInput): DecideOutput {
  if (!Number.isFinite(input.probability)) throw new Error("decide: non-finite probability");
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new Error("decide: amount must be positive integer paise");
  }
  if (!Number.isFinite(input.nowMs)) throw new Error("decide: non-finite clock");

  const evaluated = ACTIONS.map((a) => evaluateAction(input, a));

  const order = new Map<ActionId, number>(ACTIONS.map((a, i) => [a, i]));
  const feasible = evaluated
    .filter((e) => e.violations.length === 0)
    .map((e) => e.ev)
    .sort((a, b) => b.evPaise - a.evPaise || order.get(a.action)! - order.get(b.action)!);

  const refusals: RefusalRecord[] = evaluated
    .filter((e) => e.violations.length > 0)
    .map((e) => ({ action: e.ev.action, violatedRules: e.violations }));

  let ranked = feasible;
  let fallbackReason: string | null = null;
  if (ranked.length === 0) {
    const noAction = evaluated.find((e) => e.ev.action === "NO_ACTION")!;
    ranked = [noAction.ev];
    fallbackReason = `ALL_ACTIONS_CONSTRAINED: ${refusals
      .flatMap((r) => r.violatedRules)
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .join(",")}`;
  }

  return { ranked, chosen: ranked[0]!, refusals, fallbackReason };
}

export function describeChoice(chosen: RankedAction, amountPaise: number): string {
  const pct = (chosen.adjustedProbabilityBp / 100).toFixed(1);
  return `${chosen.action}: est. ${pct}% recovery on ${formatINR(paise(amountPaise))} (EV ${formatINR(paise(chosen.evPaise))})`;
}
