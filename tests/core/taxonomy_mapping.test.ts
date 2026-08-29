import { describe, it, expect } from "vitest";
import { diagnoseFailure } from "../../packages/core/src/diagnosis.js";
import { classifyByCode } from "../../packages/ml/src/features.js";

describe("Taxonomy & Error Code Decomposition (Task 1.1)", () => {
  const codesByClass = {
    SOFT_RETRYABLE: [
      "INSUFFICIENT_FUNDS",
      "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
      "BAD_REQUEST_PAYMENT_UPI_COLLECT_EXPIRED",
      "BAD_REQUEST_PAYMENT_OTP_VALIDATION_FAILED",
      "LOCAL_INSUFFICIENT_FUNDS",
    ],
    HARD_METHOD_DEAD: [
      "CARD_EXPIRED",
      "BAD_REQUEST_PAYMENT_CARD_EXPIRED",
      "BAD_REQUEST_PAYMENT_CARD_INVALID",
      "BAD_REQUEST_PAYMENT_MANDATE_REVOKED",
      "LOCAL_EXPIRED_METHOD",
    ],
    NETWORK_TIMEOUT: [
      "GATEWAY_TIMEOUT",
      "GATEWAY_ERROR",
      "BANK_DOWNTIME_NETWORK_ERROR",
      "BAD_REQUEST_PAYMENT_TIMED_OUT",
      "LOCAL_GATEWAY_TIMEOUT",
    ],
    RISK_FLAGGED: [
      "SUSPECTED_FRAUD",
      "BAD_REQUEST_PAYMENT_FRAUD_IDENTIFIED",
      "BAD_REQUEST_PAYMENT_CARD_STOLEN",
      "LOCAL_RISK_REJECTED",
    ],
    UNKNOWN: ["BAD_REQUEST_PAYMENT_DECLINED_BY_BANK", "UNKNOWN_CODE"],
  };

  it("correctly decomposes SOFT_RETRYABLE balance and collect timeout errors", () => {
    const d1 = diagnoseFailure("BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE", "SOFT_RETRYABLE");
    expect(d1.rootCause).toBe("INSUFFICIENT_FUNDS");
    expect(d1.recommendedIntervention).toBe("RETRY_PAYDAY");

    const cls = classifyByCode("BAD_REQUEST_PAYMENT_UPI_COLLECT_EXPIRED", codesByClass);
    expect(cls).toBe("SOFT_RETRYABLE");
  });

  it("correctly decomposes HARD_METHOD_DEAD card and mandate expiration errors", () => {
    const d1 = diagnoseFailure("BAD_REQUEST_PAYMENT_CARD_EXPIRED", "HARD_METHOD_DEAD");
    expect(d1.rootCause).toBe("METHOD_EXPIRED");
    expect(d1.recommendedIntervention).toBe("ALTERNATE_METHOD");

    const d2 = diagnoseFailure("BAD_REQUEST_PAYMENT_MANDATE_REVOKED", "HARD_METHOD_DEAD");
    expect(d2.rootCause).toBe("METHOD_EXPIRED");
    expect(d2.recommendedIntervention).toBe("ALTERNATE_METHOD");
  });

  it("correctly decomposes NETWORK_TIMEOUT gateway and issuer outage errors", () => {
    const d1 = diagnoseFailure("BANK_DOWNTIME_NETWORK_ERROR", "NETWORK_TIMEOUT");
    expect(d1.rootCause).toBe("NETWORK_GATEWAY");
    expect(d1.recommendedIntervention).toBe("RETRY_SOON");
  });

  it("correctly decomposes RISK_FLAGGED fraud and stolen instrument errors", () => {
    const d1 = diagnoseFailure("BAD_REQUEST_PAYMENT_FRAUD_IDENTIFIED", "RISK_FLAGGED");
    expect(d1.rootCause).toBe("RISK_FLAGGED");
    expect(d1.recommendedIntervention).toBe("ESCALATE_HUMAN");
  });

  it("fails closed to UNKNOWN for unmapped foreign error codes", () => {
    const d1 = diagnoseFailure("COMPLETELY_NEW_BANK_ERROR_999", "UNKNOWN");
    expect(d1.rootCause).toBe("UNKNOWN");
    expect(d1.recommendedIntervention).toBe("INVESTIGATE");

    const cls = classifyByCode("SOME_WEIRD_CODE_XYZ", codesByClass);
    expect(cls).toBe("UNKNOWN");
  });
});
