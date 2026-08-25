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

/**
 * Intervention catalog + action-conditioned multipliers now live in the
 * decision engine (@arbiter/core/decide) — canonical single source.
 * Re-exported here for generator-side compatibility.
 */
export {
  ACTIONS,
  DEFAULT_ACTION_MULTIPLIERS as ACTION_MULTIPLIERS,
  type ActionId,
} from "@arbiter/core/decide";

