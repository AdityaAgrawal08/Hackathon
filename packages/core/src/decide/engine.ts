/**
 * Decision engine scaffold (P3) — argmax expected-value under constraints.
 *
 * Contracts enforced here (tested, not assumed):
 *  - TOTALITY: decide() never throws and never returns an empty slate —
 *    a fully-constrained customer yields a mandatory NO_ACTION proposal
 *    carrying the complete refusal rule set (bugs P3-B3/P3-B4).
 *  - MONEY: all EV math is integer paise via basis points; EV of any action
 *    can never exceed amount_paise (invariant I-5, bug P3-B1).
 *  - DETERMINISM: ranking is EV-desc with catalog-index tie-break; identical
 *    inputs ⇒ identical ranking forever (bug P3-B2).
 */
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
import { formatINR, paise, percentBp } from "@arbiter/shared";

export interface DecideInput {
  /** Calibrated P(recovery) from the incumbent model (ml package). */
  probability: number;
  failureClass: FailureClassId;
  amountPaise: number;
  nowMs: number;
  policy: PolicyPack;
  attemptsSoFar?: number;
  lastContactAtMs?: number | null;
  customerOptedOut?: boolean;
  multipliers?: Multipliers;
}

export interface RankedAction {
  action: ActionId;
  /** Expected value in integer paise: round(P×mult × amount) − contact cost. */
  evPaise: number;
  /** Adjusted probability in basis points (probability × multiplier). */
  adjustedProbabilityBp: number;
  multiplierUsed: number;
}

export interface RefusalRecord {
  action: ActionId;
  violatedRules: RuleId[];
}

export interface DecideOutput {
  /** Feasible actions, EV-descending, catalog-order tie-break. Never empty. */
  ranked: RankedAction[];
  /** ranked[0] — always present; NO_ACTION is universally feasible. */
  chosen: RankedAction;
  /** Infeasible actions with EVERY matched rule — ledger REFUSAL material. */
  refusals: RefusalRecord[];
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Integer-only expected value. Returns null when the action is not feasible. */
function evaluateAction(
  input: DecideInput,
  action: ActionId,
): { ev: RankedAction; violations: RuleId[] } {
  const mult = multiplierFor(input.failureClass, action, input.multipliers);
  const pBp = Math.round(clamp01(input.probability * mult) * 10_000);
  const amount = paise(input.amountPaise); // throws on non-integer — fail closed

  const ctx = {
    failureClass: input.failureClass,
    amountPaise: input.amountPaise,
    probabilityBp: pBp,
    nowMs: input.nowMs,
    attemptsSoFar: input.attemptsSoFar ?? 0,
    lastContactAtMs: input.lastContactAtMs ?? null,
    customerOptedOut: input.customerOptedOut ?? false,
    isContactAction: isContactAction(action),
  };
  const violations = evaluateConstraints(input.policy, ctx);

  // Gross expected recovery via integer bp math, minus explicit cost.
  const gross = percentBp(amount, pBp);
  const ev = {
    action,
    evPaise: gross - CONTACT_COST_PAISE[action],
    adjustedProbabilityBp: pBp,
    multiplierUsed: mult,
  };
  return { ev, violations };
}

/**
 * Rank all catalog actions. Total function: never throws on constrained
 * customers; NO_ACTION (EV baseline 0) is always feasible.
 */
export function decide(input: DecideInput): DecideOutput {
  if (!Number.isFinite(input.probability)) throw new Error("decide: non-finite probability");
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new Error("decide: amount must be positive integer paise");
  }
  if (!Number.isFinite(input.nowMs)) throw new Error("decide: non-finite clock");

  const evaluated = ACTIONS.map((a) => evaluateAction(input, a));
  const rankedAll = evaluated.map((e) => e.ev);

  // Stable comparator: EV desc, then catalog index asc (P3-B2).
  const order = new Map<ActionId, number>(ACTIONS.map((a, i) => [a, i]));
  const feasible = evaluated
    .filter((e) => e.violations.length === 0)
    .map((e) => e.ev)
    .sort(
      (a, b) =>
        b.evPaise - a.evPaise || (order.get(a.action)! - order.get(b.action)!),
    );

  const refusals: RefusalRecord[] = evaluated
    .filter((e) => e.violations.length > 0)
    .map((e) => ({ action: e.ev.action, violatedRules: e.violations }));

  let ranked = feasible;
  if (ranked.length === 0) {
    // Mandatory fallback proposal — the engine NEVER returns an empty set.
    const noAction = rankedAll.find((r) => r.action === "NO_ACTION")!;
    ranked = [noAction];
  }

  return { ranked, chosen: ranked[0]!, refusals };
}

/** Human-readable one-liner used by proposals/narratives (₹ formatting central). */
export function describeChoice(chosen: RankedAction, amountPaise: number): string {
  const pct = (chosen.adjustedProbabilityBp / 100).toFixed(1);
  return `${chosen.action}: est. ${pct}% recovery on ${formatINR(paise(amountPaise))} (EV ₹${(chosen.evPaise / 100).toFixed(2)})`;
}
