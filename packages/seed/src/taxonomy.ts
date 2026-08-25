/**
 * Failure taxonomy — the triage classes that drive everything downstream.
 * Shares are modeling choices (cited in docs/metrics-methodology.md); the
 * generator asserts emitted frequencies stay within ±5pp bands (bug P1-B2).
 */
export const FAILURE_CLASSES = [
  "SOFT_RETRYABLE",
  "HARD_METHOD_DEAD",
  "NETWORK_TIMEOUT",
  "RISK_FLAGGED",
  "UNKNOWN",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const CLASS_SHARES: Record<FailureClass, number> = {
  SOFT_RETRYABLE: 0.45,
  HARD_METHOD_DEAD: 0.25,
  NETWORK_TIMEOUT: 0.15,
  RISK_FLAGGED: 0.1,
  UNKNOWN: 0.05,
};

/** Tolerance band for share assertions (F5 amendment: never exact equality). */
export const SHARE_TOLERANCE_PP = 5; // percentage points

/** Synthetic-but-plausible decline codes per class. */
export const CODES_BY_CLASS: Record<FailureClass, readonly string[]> = {
  SOFT_RETRYABLE: ["INSUFFICIENT_FUNDS", "TEMPORARY_DECLINE", "NO_MANDATE_RESPONSE"],
  HARD_METHOD_DEAD: ["CARD_EXPIRED", "MANDATE_REVOKED", "TOKEN_INVALID"],
  NETWORK_TIMEOUT: ["GATEWAY_TIMEOUT", "ISSUER_TIMEOUT", "NETWORK_ERROR"],
  RISK_FLAGGED: ["SUSPECTED_FRAUD", "RISK_BLOCKED"],
  UNKNOWN: ["UNKNOWN_CODE"],
};

/** Interventions the DECIDE engine may choose from (catalog order = tie-break). */
export const ACTIONS = [
  "RETRY_NOW",
  "RETRY_PAYDAY",
  "ALTERNATE_UPI_LINK",
  "REMINDER_LINK",
  "HUMAN_REVIEW",
  "NO_ACTION",
] as const;

export type ActionId = (typeof ACTIONS)[number];

/**
 * Action-conditioned recovery multipliers applied to the base model score.
 * Documented assumptions, not measurements — cited in metrics-methodology.md.
 * A multiplier of 0 means the action can NEVER recover that class
 * (blind retry of a dead method) — the fact that powers the whole pitch.
 */
export const ACTION_MULTIPLIERS: Record<FailureClass, Record<ActionId, number>> = {
  SOFT_RETRYABLE: {
    RETRY_NOW: 0.6,
    RETRY_PAYDAY: 1.4,
    ALTERNATE_UPI_LINK: 0.5,
    REMINDER_LINK: 0.7,
    HUMAN_REVIEW: 0.3,
    NO_ACTION: 0.02,
  },
  HARD_METHOD_DEAD: {
    RETRY_NOW: 0.0,
    RETRY_PAYDAY: 0.0,
    ALTERNATE_UPI_LINK: 1.0,
    REMINDER_LINK: 0.6,
    HUMAN_REVIEW: 0.1,
    NO_ACTION: 0.0,
  },
  NETWORK_TIMEOUT: {
    RETRY_NOW: 1.5,
    RETRY_PAYDAY: 0.4,
    ALTERNATE_UPI_LINK: 0.3,
    REMINDER_LINK: 0.2,
    HUMAN_REVIEW: 0.05,
    NO_ACTION: 0.05,
  },
  RISK_FLAGGED: {
    RETRY_NOW: 0.0,
    RETRY_PAYDAY: 0.0,
    ALTERNATE_UPI_LINK: 0.0,
    REMINDER_LINK: 0.0,
    HUMAN_REVIEW: 1.0,
    NO_ACTION: 0.0,
  },
  UNKNOWN: {
    RETRY_NOW: 0.1,
    RETRY_PAYDAY: 0.1,
    ALTERNATE_UPI_LINK: 0.1,
    REMINDER_LINK: 0.1,
    HUMAN_REVIEW: 1.0,
    NO_ACTION: 0.0,
  },
};
