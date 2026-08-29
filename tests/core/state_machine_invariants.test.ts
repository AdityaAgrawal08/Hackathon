import { describe, it, expect } from "vitest";
import {
  canTransitionProviderStatus,
  assertValidProviderTransition,
  canTransitionKnowledgeStatus,
  assertValidKnowledgeTransition,
  canTransitionReconciliationStatus,
  InvalidStateTransitionError,
} from "../../packages/core/src/executor/payment_state_machine.js";

describe("Authoritative Four-Dimensional Payment State Machine", () => {
  describe("ProviderPaymentStatus transitions", () => {
    it("permits valid monotonic progression: CREATED -> AUTHORIZED -> CAPTURED", () => {
      expect(canTransitionProviderStatus("CREATED", "AUTHORIZED")).toBe(true);
      expect(canTransitionProviderStatus("AUTHORIZED", "CAPTURED")).toBe(true);
    });

    it("permits direct CREATED -> CAPTURED (immediate capture)", () => {
      expect(canTransitionProviderStatus("CREATED", "CAPTURED")).toBe(true);
    });

    it("permits CREATED -> FAILED and AUTHORIZED -> FAILED", () => {
      expect(canTransitionProviderStatus("CREATED", "FAILED")).toBe(true);
      expect(canTransitionProviderStatus("AUTHORIZED", "FAILED")).toBe(true);
    });

    it("FAIL-CLOSED: rejects regression from CAPTURED to FAILED or CREATED", () => {
      expect(canTransitionProviderStatus("CAPTURED", "FAILED")).toBe(false);
      expect(canTransitionProviderStatus("CAPTURED", "CREATED")).toBe(false);
      expect(canTransitionProviderStatus("CAPTURED", "AUTHORIZED")).toBe(false);

      expect(() => assertValidProviderTransition("CAPTURED", "FAILED")).toThrow(
        InvalidStateTransitionError,
      );
    });

    it("FAIL-CLOSED: rejects transition out of terminal FAILED", () => {
      expect(canTransitionProviderStatus("FAILED", "CAPTURED")).toBe(false);
      expect(canTransitionProviderStatus("FAILED", "AUTHORIZED")).toBe(false);
    });
  });

  describe("KnowledgeStatus transitions", () => {
    it("permits resolution from UNRESOLVED_PENDING to RESOLVED_SUCCESS or RESOLVED_FAILED", () => {
      expect(canTransitionKnowledgeStatus("UNRESOLVED_PENDING", "RESOLVED_SUCCESS")).toBe(true);
      expect(canTransitionKnowledgeStatus("UNRESOLVED_PENDING", "RESOLVED_FAILED")).toBe(true);
    });

    it("permits transition into UNRESOLVED_UNKNOWN holding state on transport loss", () => {
      expect(canTransitionKnowledgeStatus("UNRESOLVED_PENDING", "UNRESOLVED_UNKNOWN")).toBe(true);
    });

    it("permits resolution from UNRESOLVED_UNKNOWN holding state", () => {
      expect(canTransitionKnowledgeStatus("UNRESOLVED_UNKNOWN", "RESOLVED_SUCCESS")).toBe(true);
      expect(canTransitionKnowledgeStatus("UNRESOLVED_UNKNOWN", "RESOLVED_FAILED")).toBe(true);
    });

    it("FAIL-CLOSED: prevents terminal RESOLVED_SUCCESS from regressing to UNKNOWN or FAILED", () => {
      expect(canTransitionKnowledgeStatus("RESOLVED_SUCCESS", "UNRESOLVED_UNKNOWN")).toBe(false);
      expect(canTransitionKnowledgeStatus("RESOLVED_SUCCESS", "RESOLVED_FAILED")).toBe(false);

      expect(() => assertValidKnowledgeTransition("RESOLVED_SUCCESS", "RESOLVED_FAILED")).toThrow(
        InvalidStateTransitionError,
      );
    });
  });

  describe("ReconciliationStatus transitions", () => {
    it("permits progression: NONE -> RECONCILING -> RECONCILED", () => {
      expect(canTransitionReconciliationStatus("NONE", "RECONCILING")).toBe(true);
      expect(canTransitionReconciliationStatus("RECONCILING", "RECONCILED")).toBe(true);
    });

    it("permits timeout transition to RECONCILIATION_EXHAUSTED -> MANUAL_REVIEW_REQUIRED", () => {
      expect(canTransitionReconciliationStatus("RECONCILING", "RECONCILIATION_EXHAUSTED")).toBe(true);
      expect(canTransitionReconciliationStatus("RECONCILIATION_EXHAUSTED", "MANUAL_REVIEW_REQUIRED")).toBe(true);
    });
  });
});
