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
import { nextPaydayWindowMs } from "./window.js";
import { formatINR, paise, percentBp } from "@arbiter/shared";

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

function scheduleFor(action: ActionId, input: DecideInput): number | null {
  if (action === "RETRY_NOW") return input.nowMs;
  if (action === "RETRY_PAYDAY") {
    const day = input.inferredPaydayDay;
    return day !== null && day !== undefined ? nextPaydayWindowMs(day, input.nowMs) : null;
  }
  return null;
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
      (input.inferredPaydayDay !== null && input.inferredPaydayDay !== undefined),
  };
  const violations = evaluateConstraints(input.policy, ctx);

  const gross = percentBp(amount, pBp);
  const ev: RankedAction = {
    action,
    evPaise: gross - CONTACT_COST_PAISE[action],
    adjustedProbabilityBp: pBp,
    multiplierUsed: mult,
    scheduledForMs: violations.length === 0 ? scheduleFor(action, input) : null,
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
  return `${chosen.action}: est. ${pct}% recovery on ${formatINR(paise(amountPaise))} (EV ₹${(chosen.evPaise / 100).toFixed(2)})`;
}
