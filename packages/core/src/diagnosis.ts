/**
 * Root-cause diagnosis — Track 3 brief: "Payment degradation → root cause → recovery action".
 *
 * Decomposes Razorpay error codes, decline reasons, and failure classes into
 * deterministic root causes and recommended intervention families.
 */
import type { FailureClassId } from "./decide/catalog.js";

export type RootCause =
  | "INSUFFICIENT_FUNDS"
  | "METHOD_EXPIRED"
  | "NETWORK_GATEWAY"
  | "RISK_FLAGGED"
  | "UNKNOWN";

export type InterventionFamily =
  | "RETRY_SOON"
  | "RETRY_PAYDAY"
  | "ALTERNATE_METHOD"
  | "ESCALATE_HUMAN"
  | "INVESTIGATE";

export interface Diagnosis {
  failureCode: string;
  failureClass: FailureClassId;
  rootCause: RootCause;
  /** Human-readable explanation for merchant + audit trail. */
  explanation: string;
  /** Intervention family this root cause maps to. */
  recommendedIntervention: InterventionFamily;
}

/** Comprehensive Razorpay + industry error code mapping */
const ROOT_CAUSE_BY_CODE: Record<string, RootCause> = {
  // Soft Retryable / Balance / Transients
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE: "INSUFFICIENT_FUNDS",
  BAD_REQUEST_PAYMENT_UPI_COLLECT_EXPIRED: "INSUFFICIENT_FUNDS",
  BAD_REQUEST_PAYMENT_OTP_VALIDATION_FAILED: "INSUFFICIENT_FUNDS",
  TEMPORARY_DECLINE: "INSUFFICIENT_FUNDS",
  NO_MANDATE_RESPONSE: "INSUFFICIENT_FUNDS",
  LOCAL_INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  RZP_INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",

  // Hard Method Dead
  CARD_EXPIRED: "METHOD_EXPIRED",
  BAD_REQUEST_PAYMENT_CARD_EXPIRED: "METHOD_EXPIRED",
  BAD_REQUEST_PAYMENT_CARD_INVALID: "METHOD_EXPIRED",
  BAD_REQUEST_PAYMENT_MANDATE_REVOKED: "METHOD_EXPIRED",
  BAD_REQUEST_PAYMENT_UPI_INVALID_VPA: "METHOD_EXPIRED",
  MANDATE_REVOKED: "METHOD_EXPIRED",
  TOKEN_INVALID: "METHOD_EXPIRED",
  LOCAL_EXPIRED_METHOD: "METHOD_EXPIRED",
  LOCAL_INVALID_DETAILS: "METHOD_EXPIRED",
  RZP_EXPIRED_METHOD: "METHOD_EXPIRED",
  RZP_INVALID_DETAILS: "METHOD_EXPIRED",

  // Network / Gateway / Bank Downtime
  GATEWAY_TIMEOUT: "NETWORK_GATEWAY",
  GATEWAY_ERROR: "NETWORK_GATEWAY",
  BANK_DOWNTIME_NETWORK_ERROR: "NETWORK_GATEWAY",
  BAD_REQUEST_PAYMENT_TIMED_OUT: "NETWORK_GATEWAY",
  ISSUER_TIMEOUT: "NETWORK_GATEWAY",
  NETWORK_ERROR: "NETWORK_GATEWAY",
  LOCAL_GATEWAY_TIMEOUT: "NETWORK_GATEWAY",
  LOCAL_GATEWAY_503: "NETWORK_GATEWAY",
  LOCAL_LOST_RESPONSE: "NETWORK_GATEWAY",
  RZP_RATE_LIMITED: "NETWORK_GATEWAY",
  RZP_SERVER_ERROR: "NETWORK_GATEWAY",

  // Risk / Fraud
  SUSPECTED_FRAUD: "RISK_FLAGGED",
  BAD_REQUEST_PAYMENT_FRAUD_IDENTIFIED: "RISK_FLAGGED",
  BAD_REQUEST_PAYMENT_CARD_STOLEN: "RISK_FLAGGED",
  RISK_BLOCKED: "RISK_FLAGGED",
  LOCAL_RISK_REJECTED: "RISK_FLAGGED",
  RZP_REJECTED: "RISK_FLAGGED",

  // Unknown
  BAD_REQUEST_PAYMENT_DECLINED_BY_BANK: "UNKNOWN",
  UNKNOWN_CODE: "UNKNOWN",
  UNKNOWN: "UNKNOWN",
};

const INTERVENTION_BY_ROOT_CAUSE: Record<RootCause, InterventionFamily> = {
  INSUFFICIENT_FUNDS: "RETRY_PAYDAY",
  METHOD_EXPIRED: "ALTERNATE_METHOD",
  NETWORK_GATEWAY: "RETRY_SOON",
  RISK_FLAGGED: "ESCALATE_HUMAN",
  UNKNOWN: "INVESTIGATE",
};

const EXPLANATION_BY_ROOT_CAUSE: Record<RootCause, string> = {
  INSUFFICIENT_FUNDS:
    "Customer balance was insufficient at debit time; recommend switching to an alternate bank account or UPI app, or try again later",
  METHOD_EXPIRED:
    "Card or mandate token expired/revoked; an alternate collection method is required",
  NETWORK_GATEWAY: "Transient gateway/issuer timeout; an immediate retry is safe",
  RISK_FLAGGED: "Risk engine flagged the attempt; human review is required before contact",
  UNKNOWN: "Failure code not in known taxonomy; escalate for investigation",
};

/** Deterministic, fail-closed error code classifier. */
export function classifyRazorpayError(failureCode: string): FailureClassId {
  const up = failureCode.trim().toUpperCase();

  // Exact match first (fast path for known codes)
  const ROOT_CAUSE_MAP: Record<string, FailureClassId> = {
    INSUFFICIENT_FUNDS: "SOFT_RETRYABLE",
    BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE: "SOFT_RETRYABLE",
    BAD_REQUEST_PAYMENT_UPI_COLLECT_EXPIRED: "SOFT_RETRYABLE",
    BAD_REQUEST_PAYMENT_OTP_VALIDATION_FAILED: "SOFT_RETRYABLE",
    TEMPORARY_DECLINE: "SOFT_RETRYABLE",
    NO_MANDATE_RESPONSE: "SOFT_RETRYABLE",
    LOCAL_INSUFFICIENT_FUNDS: "SOFT_RETRYABLE",
    RZP_INSUFFICIENT_FUNDS: "SOFT_RETRYABLE",
    CARD_EXPIRED: "HARD_METHOD_DEAD",
    BAD_REQUEST_PAYMENT_CARD_EXPIRED: "HARD_METHOD_DEAD",
    BAD_REQUEST_PAYMENT_CARD_INVALID: "HARD_METHOD_DEAD",
    BAD_REQUEST_PAYMENT_MANDATE_REVOKED: "HARD_METHOD_DEAD",
    BAD_REQUEST_PAYMENT_UPI_INVALID_VPA: "HARD_METHOD_DEAD",
    MANDATE_REVOKED: "HARD_METHOD_DEAD",
    TOKEN_INVALID: "HARD_METHOD_DEAD",
    LOCAL_EXPIRED_METHOD: "HARD_METHOD_DEAD",
    LOCAL_INVALID_DETAILS: "HARD_METHOD_DEAD",
    RZP_EXPIRED_METHOD: "HARD_METHOD_DEAD",
    RZP_INVALID_DETAILS: "HARD_METHOD_DEAD",
    GATEWAY_TIMEOUT: "NETWORK_TIMEOUT",
    GATEWAY_ERROR: "NETWORK_TIMEOUT",
    BANK_DOWNTIME_NETWORK_ERROR: "NETWORK_TIMEOUT",
    BAD_REQUEST_PAYMENT_TIMED_OUT: "NETWORK_TIMEOUT",
    ISSUER_TIMEOUT: "NETWORK_TIMEOUT",
    NETWORK_ERROR: "NETWORK_TIMEOUT",
    LOCAL_GATEWAY_TIMEOUT: "NETWORK_TIMEOUT",
    LOCAL_GATEWAY_503: "NETWORK_TIMEOUT",
    LOCAL_LOST_RESPONSE: "NETWORK_TIMEOUT",
    RZP_RATE_LIMITED: "NETWORK_TIMEOUT",
    RZP_SERVER_ERROR: "NETWORK_TIMEOUT",
    SUSPECTED_FRAUD: "RISK_FLAGGED",
    BAD_REQUEST_PAYMENT_FRAUD_IDENTIFIED: "RISK_FLAGGED",
    BAD_REQUEST_PAYMENT_CARD_STOLEN: "RISK_FLAGGED",
    RISK_BLOCKED: "RISK_FLAGGED",
    LOCAL_RISK_REJECTED: "RISK_FLAGGED",
    RZP_REJECTED: "RISK_FLAGGED",
    BAD_REQUEST_PAYMENT_DECLINED_BY_BANK: "UNKNOWN",
    UNKNOWN_CODE: "UNKNOWN",
    UNKNOWN: "UNKNOWN",
  };

  if (ROOT_CAUSE_MAP[up]) return ROOT_CAUSE_MAP[up];

  // Substring fallback — order matters (most specific first)
  if (up.includes("FRAUD") || up.includes("STOLEN") || up.includes("SUSPECTED")) return "RISK_FLAGGED";
  if (up.includes("EXPIRED") || up.includes("REVOKED") || up.includes("INVALID_CARD") || up.includes("INVALID_VPA")) return "HARD_METHOD_DEAD";
  if (up.includes("CARD") && (up.includes("CLOSED") || up.includes("BLOCKED") || up.includes("LIMIT"))) return "HARD_METHOD_DEAD";
  if (up.includes("BANK_DOWNTIME") || up.includes("GATEWAY") || up.includes("TIMEOUT") || up.includes("NETWORK")) return "NETWORK_TIMEOUT";
  if (up.includes("INSUFFICIENT") || up.includes("BALANCE") || up.includes("COLLECT_EXPIRED") || up.includes("OTP")) return "SOFT_RETRYABLE";
  if (up.includes("DECLINED") || up.includes("DO_NOT_HONOR")) return "SOFT_RETRYABLE";

  return "UNKNOWN";
}

/** Deterministic, fail-closed diagnosis. Unknown codes → UNKNOWN → INVESTIGATE. */
export function diagnoseFailure(
  failureCode: string,
  failureClass: FailureClassId = classifyRazorpayError(failureCode),
): Diagnosis {
  const up = failureCode.trim().toUpperCase();
  const rootCause = ROOT_CAUSE_BY_CODE[up] ?? (
    failureClass === "SOFT_RETRYABLE"
      ? "INSUFFICIENT_FUNDS"
      : failureClass === "HARD_METHOD_DEAD"
        ? "METHOD_EXPIRED"
        : failureClass === "NETWORK_TIMEOUT"
          ? "NETWORK_GATEWAY"
          : failureClass === "RISK_FLAGGED"
            ? "RISK_FLAGGED"
            : "UNKNOWN"
  );

  return {
    failureCode: up,
    failureClass,
    rootCause,
    explanation: EXPLANATION_BY_ROOT_CAUSE[rootCause],
    recommendedIntervention: INTERVENTION_BY_ROOT_CAUSE[rootCause],
  };
}

