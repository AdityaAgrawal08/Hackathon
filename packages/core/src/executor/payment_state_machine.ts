/**
 * Four-Dimensional Authoritative Payment State Machine.
 *
 * Defines the state types and monotonic transition rules across:
 * 1. ProviderPaymentStatus (CREATED | AUTHORIZED | CAPTURED | FAILED)
 * 2. LocalSettlementStatus (UNSETTLED | SETTLED)
 * 3. KnowledgeStatus (UNRESOLVED_PENDING | RESOLVED_SUCCESS | RESOLVED_FAILED | UNRESOLVED_UNKNOWN)
 * 4. ReconciliationStatus (NONE | RECONCILING | RECONCILED | RECONCILIATION_EXHAUSTED | MANUAL_REVIEW_REQUIRED)
 */

export type ProviderPaymentStatus = "CREATED" | "AUTHORIZED" | "CAPTURED" | "FAILED";
export type LocalSettlementStatus = "UNSETTLED" | "SETTLED";
export type KnowledgeStatus =
  | "UNRESOLVED_PENDING"
  | "RESOLVED_SUCCESS"
  | "RESOLVED_FAILED"
  | "UNRESOLVED_UNKNOWN";
export type ReconciliationStatus =
  | "NONE"
  | "RECONCILING"
  | "RECONCILED"
  | "RECONCILIATION_EXHAUSTED"
  | "MANUAL_REVIEW_REQUIRED";

export class InvalidStateTransitionError extends Error {
  constructor(dimension: string, from: string, to: string) {
    super(`InvalidStateTransitionError: Cannot transition ${dimension} from ${from} to ${to}`);
    this.name = "InvalidStateTransitionError";
  }
}

// 1. Provider Execution Hierarchy
const PROVIDER_STATUS_HIERARCHY: Record<ProviderPaymentStatus, number> = {
  CREATED: 0,
  AUTHORIZED: 1,
  CAPTURED: 2,
  FAILED: 2,
};

const VALID_PROVIDER_TRANSITIONS: Record<ProviderPaymentStatus, readonly ProviderPaymentStatus[]> = {
  CREATED: ["AUTHORIZED", "CAPTURED", "FAILED"],
  AUTHORIZED: ["CAPTURED", "FAILED"],
  CAPTURED: [], // Terminal capture for initial payment (refunds/disputes are separate flows)
  FAILED: [],   // Terminal decline
};

export function canTransitionProviderStatus(
  current: ProviderPaymentStatus,
  next: ProviderPaymentStatus,
): boolean {
  if (current === next) return true;
  return VALID_PROVIDER_TRANSITIONS[current].includes(next);
}

export function assertValidProviderTransition(
  current: ProviderPaymentStatus,
  next: ProviderPaymentStatus,
): void {
  if (!canTransitionProviderStatus(current, next)) {
    throw new InvalidStateTransitionError("ProviderPaymentStatus", current, next);
  }
}

// 2. Knowledge Status Hierarchy & Resolution Rules
const VALID_KNOWLEDGE_TRANSITIONS: Record<KnowledgeStatus, readonly KnowledgeStatus[]> = {
  UNRESOLVED_PENDING: ["RESOLVED_SUCCESS", "RESOLVED_FAILED", "UNRESOLVED_UNKNOWN"],
  UNRESOLVED_UNKNOWN: ["RESOLVED_SUCCESS", "RESOLVED_FAILED"], // Holding state
  RESOLVED_SUCCESS: [], // Terminal
  RESOLVED_FAILED: ["RESOLVED_SUCCESS"], // Rare conflict override if provider proves capture
};

export function canTransitionKnowledgeStatus(
  current: KnowledgeStatus,
  next: KnowledgeStatus,
): boolean {
  if (current === next) return true;
  return VALID_KNOWLEDGE_TRANSITIONS[current].includes(next);
}

export function assertValidKnowledgeTransition(
  current: KnowledgeStatus,
  next: KnowledgeStatus,
): void {
  if (!canTransitionKnowledgeStatus(current, next)) {
    throw new InvalidStateTransitionError("KnowledgeStatus", current, next);
  }
}

// 3. Reconciliation Status Transitions
const VALID_RECONCILIATION_TRANSITIONS: Record<ReconciliationStatus, readonly ReconciliationStatus[]> = {
  NONE: ["RECONCILING", "RECONCILED"],
  RECONCILING: ["RECONCILED", "RECONCILIATION_EXHAUSTED"],
  RECONCILIATION_EXHAUSTED: ["MANUAL_REVIEW_REQUIRED"],
  MANUAL_REVIEW_REQUIRED: ["RECONCILED"],
  RECONCILED: [],
};

export function canTransitionReconciliationStatus(
  current: ReconciliationStatus,
  next: ReconciliationStatus,
): boolean {
  if (current === next) return true;
  return VALID_RECONCILIATION_TRANSITIONS[current].includes(next);
}
