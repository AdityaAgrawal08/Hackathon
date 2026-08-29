/**
 * Decision-engine scaffold (P3) — intervention catalog + cost model.
 *
 * Canonical home of the action catalog (catalog order = stable tie-break,
 * bug P3-B2). The adjustment table is DOCUMENTED ASSUMPTION, not measurement
 * — every cell must exist (completeness-tested); runtime lookups are total
 * with a fail-closed default of 0 (unknown cell can never recover money).
 *
 * Money invariant I-5: costs are integer paise; EV math stays integer via
 * basis points (see engine.ts). HUMAN_REVIEW carries explicit labor cost and
 * NO_ACTION is the zero-EV baseline so the optimizer cannot "dodge" into a
 * free option (bug P3-B6).
 */
import { paise, type Paise } from "@arbiter/shared";

/** Catalog order is normative: ties in EV break toward the earlier entry. */
export const ACTIONS = [
  "RETRY_NOW",
  "RETRY_PAYDAY",
  "ALTERNATE_UPI_LINK",
  "RECOVER_VIA_RAIL",
  "RECOVER_VOICE_HI",
  "RECOVER_WHATSAPP",
  "PROMISE_TO_PAY",
  "REMINDER_LINK",
  "HUMAN_REVIEW",
  "NO_ACTION",
] as const;

export type ActionId = (typeof ACTIONS)[number];

/** Rails a failed Razorpay charge can be recovered through (§4.1 moat). */
export type RecoveryRail =
  | "razorpay_payment_link" // card/UPI Payment Link on the same PSP
  | "smart_collect_upi" // Razorpay Smart Collect UPI (B2B)
  | "optimizer_secondary_psp"; // Razorpay Optimizer → secondary PSP

/**
 * Map a failure class to the best alternate rail. A single PSP can never mix
 * merchant data, but a neutral recovery agent CAN switch rails for the one
 * merchant that owns several — that is the cross-PSP moat.
 *   HARD_METHOD_DEAD  → same-PSP Payment Link (the method is dead, not the PSP)
 *   NETWORK_TIMEOUT   → Optimizer routes to a secondary PSP (issuer was down)
 *   SOFT_RETRYABLE    → Payment Link (a nudge on a different instrument)
 */
export function railForFailureClass(cls: FailureClassId): RecoveryRail {
  switch (cls) {
    case "HARD_METHOD_DEAD":
      return "razorpay_payment_link";
    case "NETWORK_TIMEOUT":
      return "optimizer_secondary_psp";
    case "SOFT_RETRYABLE":
      return "razorpay_payment_link";
    default:
      return "razorpay_payment_link";
  }
}

/** Structurally identical to the seed generator's FailureClass — no import, no cycle. */
export type FailureClassId =
  | "SOFT_RETRYABLE"
  | "HARD_METHOD_DEAD"
  | "NETWORK_TIMEOUT"
  | "RISK_FLAGGED"
  | "UNKNOWN";

/**
 * Per-action contact cost in integer paise (cited assumption, metrics-methodology).
 * HUMAN_REVIEW prices merchant labor; every contact action costs > 0 so spamming
 * cannot win the argmax (P3-B6/P7-B7).
 */
export const CONTACT_COST_PAISE: Record<ActionId, Paise> = {
  RETRY_NOW: paise(300),
  RETRY_PAYDAY: paise(300),
  ALTERNATE_UPI_LINK: paise(150),
  RECOVER_VIA_RAIL: paise(200),
  RECOVER_VOICE_HI: paise(800),
  RECOVER_WHATSAPP: paise(120),
  PROMISE_TO_PAY: paise(80),
  REMINDER_LINK: paise(100),
  HUMAN_REVIEW: paise(5000),
  NO_ACTION: paise(0),
};

/** Actions that reach the customer (subject to conduct constraints). */
const CONTACT_ACTIONS: ReadonlySet<ActionId> = new Set([
  "RETRY_NOW",
  "RETRY_PAYDAY",
  "ALTERNATE_UPI_LINK",
  "RECOVER_VIA_RAIL",
  "RECOVER_VOICE_HI",
  "RECOVER_WHATSAPP",
  "PROMISE_TO_PAY",
  "REMINDER_LINK",
]);

export function isContactAction(action: ActionId): boolean {
  return CONTACT_ACTIONS.has(action);
}

/**
 * Action-conditioned recovery multipliers on the base model score.
 * A 0 cell means the action can NEVER recover that class (blind retry of a
 * dead method) — the fact that powers the whole pitch.
 */
export const DEFAULT_ACTION_MULTIPLIERS: Record<FailureClassId, Record<ActionId, number>> = {
  SOFT_RETRYABLE: {
    RETRY_NOW: 0.6,
    RETRY_PAYDAY: 1.4,
    ALTERNATE_UPI_LINK: 0.5,
    RECOVER_VIA_RAIL: 0.3,
    RECOVER_VOICE_HI: 0.8,
    RECOVER_WHATSAPP: 0.7,
    PROMISE_TO_PAY: 0.5,
    REMINDER_LINK: 0.7,
    HUMAN_REVIEW: 0.3,
    NO_ACTION: 0.02,
  },
  HARD_METHOD_DEAD: {
    RETRY_NOW: 0.0,
    RETRY_PAYDAY: 0.0,
    ALTERNATE_UPI_LINK: 1.0,
    RECOVER_VIA_RAIL: 1.1,
    RECOVER_VOICE_HI: 0.5,
    RECOVER_WHATSAPP: 0.4,
    PROMISE_TO_PAY: 0.7,
    REMINDER_LINK: 0.6,
    HUMAN_REVIEW: 0.1,
    NO_ACTION: 0.0,
  },
  NETWORK_TIMEOUT: {
    RETRY_NOW: 1.5,
    RETRY_PAYDAY: 0.4,
    ALTERNATE_UPI_LINK: 0.3,
    RECOVER_VIA_RAIL: 1.6,
    RECOVER_VOICE_HI: 0.6,
    RECOVER_WHATSAPP: 0.5,
    PROMISE_TO_PAY: 0.4,
    REMINDER_LINK: 0.2,
    HUMAN_REVIEW: 0.05,
    NO_ACTION: 0.05,
  },
  RISK_FLAGGED: {
    RETRY_NOW: 0.0,
    RETRY_PAYDAY: 0.0,
    ALTERNATE_UPI_LINK: 0.0,
    RECOVER_VIA_RAIL: 0.0,
    RECOVER_VOICE_HI: 0.0,
    RECOVER_WHATSAPP: 0.0,
    PROMISE_TO_PAY: 0.2,
    REMINDER_LINK: 0.0,
    HUMAN_REVIEW: 1.0,
    NO_ACTION: 0.0,
  },
  UNKNOWN: {
    RETRY_NOW: 0.1,
    RETRY_PAYDAY: 0.1,
    ALTERNATE_UPI_LINK: 0.1,
    RECOVER_VIA_RAIL: 0.1,
    RECOVER_VOICE_HI: 0.2,
    RECOVER_WHATSAPP: 0.2,
    PROMISE_TO_PAY: 0.2,
    REMINDER_LINK: 0.1,
    HUMAN_REVIEW: 1.0,
    NO_ACTION: 0.0,
  },
};

/**
 * Override-shaped adjustment table: every cell optional at the edges, but
 * boot-time completeness is enforced by assertTableComplete().
 */
export type Multipliers = Record<FailureClassId, Partial<Record<ActionId, number>>>;

/**
 * Total lookup: missing cell ⇒ 0 multiplier (fail-closed, P3-B5). A custom
 * table may override any cell but never widens the domain.
 */
export function multiplierFor(
  cls: FailureClassId,
  action: ActionId,
  table: Multipliers = DEFAULT_ACTION_MULTIPLIERS,
): number {
  const cell = table[cls]?.[action];
  return typeof cell === "number" && Number.isFinite(cell)
    ? Math.min(10, Math.max(0, cell))
    : 0;
}

/** Boot-time guard: refuse incomplete tables instead of silently zeroing cells. */
export function assertTableComplete(table: Multipliers): void {
  for (const cls of Object.keys(DEFAULT_ACTION_MULTIPLIERS) as FailureClassId[]) {
    for (const action of ACTIONS) {
      const cell = table[cls]?.[action];
      if (typeof cell !== "number" || !Number.isFinite(cell)) {
        throw new Error(`adjustment table incomplete: ${cls} × ${action}`);
      }
    }
  }
}
