/**
 * Root-cause diagnosis — Track 3 brief: "Payment degradation → root cause → recovery action".
 *
 * The pipeline classifies a failure into a FailureClass (soft/hard/network/risk/unknown).
 * This module adds the EXPLICIT diagnosis step: map the raw failure code to a
 * structured root cause and a recommended intervention family. This is the
 * "diagnose" half of the agent's job, recorded as a DIAGNOSIS audit entry so the
 * loop is fully explainable end-to-end.
 *
 * Invariant: diagnosis NEVER invents a recovery amount. It only explains WHY a
 * failure happened and which intervention family is appropriate. The decision
 * engine still owns the final action + EV math.
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

/** Raw failure code → root cause taxonomy (mirrors features.ts classifyByCode). */
const ROOT_CAUSE_BY_CODE: Record<string, RootCause> = {
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  TEMPORARY_DECLINE: "INSUFFICIENT_FUNDS",
  NO_MANDATE_RESPONSE: "INSUFFICIENT_FUNDS",
  CARD_EXPIRED: "METHOD_EXPIRED",
  MANDATE_REVOKED: "METHOD_EXPIRED",
  TOKEN_INVALID: "METHOD_EXPIRED",
  GATEWAY_TIMEOUT: "NETWORK_GATEWAY",
  ISSUER_TIMEOUT: "NETWORK_GATEWAY",
  NETWORK_ERROR: "NETWORK_GATEWAY",
  SUSPECTED_FRAUD: "RISK_FLAGGED",
  RISK_BLOCKED: "RISK_FLAGGED",
  UNKNOWN_CODE: "UNKNOWN",
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
    "Customer balance was insufficient at debit time; retry aligned to predicted payday",
  METHOD_EXPIRED:
    "Card or mandate token expired/revoked; an alternate collection method is required",
  NETWORK_GATEWAY: "Transient gateway/issuer timeout; an immediate retry is safe",
  RISK_FLAGGED: "Risk engine flagged the attempt; human review is required before contact",
  UNKNOWN: "Failure code not in known taxonomy; escalate for investigation",
};

/** Deterministic, fail-closed diagnosis. Unknown codes → UNKNOWN → INVESTIGATE. */
export function diagnoseFailure(
  failureCode: string,
  failureClass: FailureClassId,
): Diagnosis {
  const up = failureCode.trim().toUpperCase();
  const rootCause = ROOT_CAUSE_BY_CODE[up] ?? "UNKNOWN";
  return {
    failureCode: up,
    failureClass,
    rootCause,
    explanation: EXPLANATION_BY_ROOT_CAUSE[rootCause],
    recommendedIntervention: INTERVENTION_BY_ROOT_CAUSE[rootCause],
  };
}
