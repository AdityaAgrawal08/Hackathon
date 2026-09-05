import { formatINR, paise, isoUtc } from "@arbiter/shared";

export interface HistoricalPaymentRecord {
  paymentId: string;
  orderId: string;
  amountPaise: number;
  occurredAtUtc: string;
  failureCode: string;
  failureDescription: string;
  failureCategory: "TECHNICAL" | "USER_ACTIONABLE" | "LIQUIDITY" | "EXPIRED_METHOD";
  method: "card" | "upi" | "netbanking" | "wallet";
  isCard: boolean;
  issuerBank: string;
  customerTier: "HIGH_VALUE" | "STANDARD" | "PRICE_SENSITIVE";
  priorSuccessCount: number;
  priorFailureCount: number;
  loggingPolicy: "CONTROL" | "NAIVE_RETRY" | "STATIC_RULES" | "HISTORICAL_AGENT";
  actionTaken: string;
  loggingPropensity: number;
  recovered: boolean;
  recoveredAtUtc?: string;
  timeToRecoverySeconds?: number;
  recoveryRail?: string;
}

class DeterministicPRNG {
  private state: number;

  constructor(seed: number = 0x5eed) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }
}

export function generateHistoricalDataset(
  count: number = 5000,
  seed: number = 0x5eed,
): HistoricalPaymentRecord[] {
  const prng = new DeterministicPRNG(seed);
  const records: HistoricalPaymentRecord[] = [];

  const banks = ["HDFC", "ICICI", "SBI", "AXIS", "KOTAK"];
  const failureCodes: Record<HistoricalPaymentRecord["failureCategory"], string[]> = {
    USER_ACTIONABLE: ["BAD_REQUEST_ERROR", "PAYMENT_CANCELLED", "INVALID_OTP", "CUSTOMER_DROPPED"],
    TECHNICAL: ["GATEWAY_ERROR", "NPCI_TIMEOUT", "ISSUER_DOWN", "NETWORK_ERROR"],
    LIQUIDITY: ["INSUFFICIENT_FUNDS", "LIMIT_EXCEEDED", "ACCOUNT_LOW_BALANCE"],
    EXPIRED_METHOD: ["CARD_EXPIRED", "CARD_BLOCKED", "ACCOUNT_CLOSED"],
  };

  const baseTimeMs = 1772400000000; // Fixed deterministic epoch baseline

  for (let i = 0; i < count; i++) {
    const paymentId = `pay_hist_${String(i + 1).padStart(5, "0")}`;
    const orderId = `order_hist_${String(i + 1).padStart(5, "0")}`;

    const rAmount = prng.next();
    const amountPaise = rAmount < 0.50
      ? Math.round((250 + prng.next() * 1750) * 100)
      : rAmount < 0.85
        ? Math.round((2000 + prng.next() * 3000) * 100)
        : Math.round((5000 + prng.next() * 10000) * 100);

    const rCat = prng.next();
    const failureCategory: HistoricalPaymentRecord["failureCategory"] =
      rCat < 0.35 ? "USER_ACTIONABLE" :
      rCat < 0.65 ? "TECHNICAL" :
      rCat < 0.85 ? "LIQUIDITY" : "EXPIRED_METHOD";

    const codeList = failureCodes[failureCategory];
    const failureCode = codeList[Math.floor(prng.next() * codeList.length)] || "PAYMENT_FAILED";
    const failureDescription = `Failure during checkout authorization: ${failureCode}`;

    const rMethod = prng.next();
    const method: HistoricalPaymentRecord["method"] =
      rMethod < 0.45 ? "card" :
      rMethod < 0.85 ? "upi" :
      rMethod < 0.95 ? "netbanking" : "wallet";
    const isCard = method === "card";

    const issuerBank = banks[Math.floor(prng.next() * banks.length)] || "HDFC";
    const rTier = prng.next();
    const customerTier: HistoricalPaymentRecord["customerTier"] =
      rTier < 0.20 ? "HIGH_VALUE" :
      rTier < 0.70 ? "STANDARD" : "PRICE_SENSITIVE";

    const priorSuccessCount = Math.floor(prng.next() * 8);
    const priorFailureCount = Math.floor(prng.next() * 4);

    const rPolicy = prng.next();
    let loggingPolicy: HistoricalPaymentRecord["loggingPolicy"];
    let actionTaken: string;
    let loggingPropensity: number;

    if (rPolicy < 0.25) {
      loggingPolicy = "CONTROL";
      actionTaken = "NO_ACTION";
      loggingPropensity = 0.25;
    } else if (rPolicy < 0.50) {
      loggingPolicy = "NAIVE_RETRY";
      actionTaken = "GATEWAY_RETRY";
      loggingPropensity = 0.25;
    } else if (rPolicy < 0.75) {
      loggingPolicy = "STATIC_RULES";
      actionTaken = "DUAL_CHANNEL_REMINDER";
      loggingPropensity = 0.25;
    } else {
      loggingPolicy = "HISTORICAL_AGENT";
      actionTaken = isCard ? "1TAP_UPI_LINK" : "SMS_1TAP_UPI";
      loggingPropensity = 0.25;
    }

    let pRecovery = 0.15;
    if (loggingPolicy === "CONTROL") {
      pRecovery = customerTier === "HIGH_VALUE" ? 0.24 : 0.12;
    } else if (loggingPolicy === "NAIVE_RETRY") {
      pRecovery = failureCategory === "TECHNICAL" ? 0.38 : 0.18;
    } else if (loggingPolicy === "STATIC_RULES") {
      pRecovery = failureCategory === "USER_ACTIONABLE" ? 0.52 : (failureCategory === "TECHNICAL" ? 0.35 : 0.22);
    } else if (loggingPolicy === "HISTORICAL_AGENT") {
      pRecovery = failureCategory === "USER_ACTIONABLE" ? 0.68 : (failureCategory === "TECHNICAL" ? 0.58 : 0.42);
    }

    const recovered = prng.next() < pRecovery;
    const timeDeltaMs = Math.floor(prng.next() * 86400000 * 30);
    const eventTimeMs = baseTimeMs + timeDeltaMs;
    const occurredAtUtc = isoUtc(eventTimeMs);

    let recoveredAtUtc: string | undefined;
    let timeToRecoverySeconds: number | undefined;
    let recoveryRail: string | undefined;

    if (recovered) {
      timeToRecoverySeconds = Math.round(120 + prng.next() * 7200);
      recoveredAtUtc = isoUtc(eventTimeMs + timeToRecoverySeconds * 1000);
      recoveryRail = isCard && loggingPolicy === "HISTORICAL_AGENT" ? "upi" : method;
    }

    records.push({
      paymentId,
      orderId,
      amountPaise,
      occurredAtUtc,
      failureCode,
      failureDescription,
      failureCategory,
      method,
      isCard,
      issuerBank,
      customerTier,
      priorSuccessCount,
      priorFailureCount,
      loggingPolicy,
      actionTaken,
      loggingPropensity,
      recovered,
      recoveredAtUtc,
      timeToRecoverySeconds,
      recoveryRail,
    });
  }

  return records;
}

export function parseHistoricalCsv(csvContent: string): HistoricalPaymentRecord[] {
  if (!csvContent || !csvContent.trim()) {
    return [];
  }

  const lines = csvContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [];

  const headerLine = lines[0]!;
  const headers = headerLine.split(",").map((h) => h.trim().toLowerCase().replace(/^["']|["']$/g, ""));

  const idCol = headers.findIndex((h) => h === "payment_id" || h === "payment id" || h === "id");
  const amountCol = headers.findIndex((h) => h === "amount" || h === "amount_paise" || h === "amount_inr");
  const codeCol = headers.findIndex((h) => h === "failure_code" || h === "error_code" || h === "code");
  const methodCol = headers.findIndex((h) => h === "method" || h === "payment_method");
  const recoveredCol = headers.findIndex((h) => h === "recovered" || h === "status");
  const policyCol = headers.findIndex((h) => h === "logging_policy" || h === "policy");
  const propensityCol = headers.findIndex((h) => h === "logging_propensity" || h === "propensity");

  const records: HistoricalPaymentRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const parts = rawLine.split(",").map((p) => p.trim().replace(/^["']|["']$/g, ""));
    if (parts.length < 2) continue;

    const paymentId = idCol >= 0 ? parts[idCol] || `pay_${i}` : `pay_${i}`;
    let amountPaise = 199900;
    if (amountCol >= 0) {
      const val = parseFloat(parts[amountCol] || "0");
      amountPaise = val > 50000 ? Math.round(val) : Math.round(val * 100);
    }
    if (amountPaise <= 0) amountPaise = 199900;

    const failureCode = codeCol >= 0 ? parts[codeCol] || "PAYMENT_FAILED" : "PAYMENT_FAILED";
    const methodStr = (methodCol >= 0 ? parts[methodCol] || "upi" : "upi").toLowerCase();
    const method: HistoricalPaymentRecord["method"] =
      methodStr.includes("card") ? "card" :
      methodStr.includes("netbank") ? "netbanking" :
      methodStr.includes("wallet") ? "wallet" : "upi";

    const recoveredStr = (recoveredCol >= 0 ? parts[recoveredCol] || "" : "").toLowerCase();
    const recovered = recoveredStr === "1" || recoveredStr === "true" || recoveredStr === "captured" || recoveredStr === "recovered";

    const loggingPolicy: HistoricalPaymentRecord["loggingPolicy"] =
      policyCol >= 0 && parts[policyCol] === "HISTORICAL_AGENT" ? "HISTORICAL_AGENT" :
      policyCol >= 0 && parts[policyCol] === "NAIVE_RETRY" ? "NAIVE_RETRY" :
      policyCol >= 0 && parts[policyCol] === "STATIC_RULES" ? "STATIC_RULES" : "CONTROL";

    const loggingPropensity = propensityCol >= 0 ? (parseFloat(parts[propensityCol] || "0.25") || 0.25) : 0.25;

    records.push({
      paymentId,
      orderId: `order_${paymentId}`,
      amountPaise,
      occurredAtUtc: new Date().toISOString(),
      failureCode,
      failureDescription: `Historical error: ${failureCode}`,
      failureCategory: failureCode.includes("EXPIRED") ? "EXPIRED_METHOD" : failureCode.includes("INSUFFICIENT") ? "LIQUIDITY" : failureCode.includes("TIMEOUT") ? "TECHNICAL" : "USER_ACTIONABLE",
      method,
      isCard: method === "card",
      issuerBank: "HDFC",
      customerTier: "STANDARD",
      priorSuccessCount: 1,
      priorFailureCount: 0,
      loggingPolicy,
      actionTaken: "RECORD_ACTION",
      loggingPropensity,
      recovered,
    });
  }

  return records;
}
