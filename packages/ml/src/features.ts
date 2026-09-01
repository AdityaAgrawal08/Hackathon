/**
 * Feature pipeline v1 (`feat-v1`) — PREDICT stage inputs.
 *
 * Invariants honored here:
 *  - Pure function of decision-time information ONLY (anti-leakage P2-B2):
 *    no field may reference anything occurring after the failure event.
 *  - Missing history ⇒ explicit sentinels, never NaN/undefined (P2-B7).
 *  - Payday inference reads the customer's noisy success histogram — the
 *    ground-truth salary day is NEVER an input (it exists only to score
 *    inference quality later).
 */
import { hashSeed, LTV_NORM_PAISE, clamp01, clamp } from "@arbiter/shared";

export const FEATURE_VERSION = "feat-v1";

/** Proxy average ticket used to estimate lifetime value from prior successes. */
export const ESTIMATED_AVG_TICKET_PAISE = 50_000;
/**
 * LTV normalization constant (saturation point for the LTV weight).
 * Defined in @arbiter/shared so the EV engine (core) and feature pipeline (ml)
 * share one value — bug fix (#1) set it to a realistic ₹25,000 (was 100× too
 * high at ₹5,00,000, which made the LTV weight effectively constant).
 */
export { LTV_NORM_PAISE };

export const FEATURE_NAMES = [
  "f_class_soft", // SOFT_RETRYABLE onehot (UNKNOWN = reference class)
  "f_class_hard", // HARD_METHOD_DEAD
  "f_class_network", // NETWORK_TIMEOUT
  "f_class_risk", // RISK_FLAGGED
  "near_payday", // 1 if event day-of-month within ±2 of inferred payday
  "payday_confidence", // obs-weighted strength of the modal-day peak
  "amount_z", // z-score vs customer's prior-failure amounts (0 if n<2)
  "prior_success_norm", // priorSuccessCount / 8, clamped
  "prior_failure_norm", // priorFailureCount / 5, clamped
  "channel_responsiveness", // merchant-supplied prior; default 0.5
  "tenure_norm", // days since joined / 400, clamped
  "ltv_paise_norm", // estimated lifetime value, normalized by LTV_NORM_PAISE
  "churn_risk_norm", // predicted churn risk, 0..1 (higher ⇒ more likely to leave)
  "days_since_last_attempt_norm", // min(days_since_last_attempt, 30) / 30
  "high_value_tier", // 1 if amount >= ₹10,000, else 0
  "bank_rail_health_norm", // rolling health score of the bank rail (0..1, default 1.0)
  // ── Payment method features (from Razorpay webhook) ──
  "is_card", // 1 if payment method is card
  "is_upi", // 1 if payment method is UPI
  "is_netbanking", // 1 if payment method is netbanking
  "is_wallet", // 1 if payment method is wallet
  "is_emi", // 1 if EMI payment
  "is_debit_card", // 1 if debit card (higher retry success than credit)
  "is_international", // 1 if international card (different rules, higher risk)
] as const;


export type FeatureName = (typeof FEATURE_NAMES)[number];
export const FEATURE_COUNT = FEATURE_NAMES.length;

/** Classes with explicit onehots; UNKNOWN is the omitted reference. */
const ONEHOT_CLASSES = ["SOFT_RETRYABLE", "HARD_METHOD_DEAD", "NETWORK_TIMEOUT", "RISK_FLAGGED"] as const;

export interface FeatureCustomerContext {
  /** Success-day-of-month histogram, e.g. {"27": 3, "28": 2} */
  paydayPattern?: Record<string, number> | null;
  channelResponsiveness?: number | null;
  priorSuccessCount?: number | null;
  joinedAtUtc?: string | null;
  optedOut?: boolean | null;
  /** §4.7 — fraction of prior promises-to-pay this customer kept (0..1). */
  promiseKeptRate?: number | null;
}

/**
 * Derive LTV + churn signals from a customer's *existing* profile (no new PII,
 * no schema change). LTV is a proxy: prior successes × estimated avg ticket.
 * Churn risk rises with unresponsiveness + opt-out and falls with tenure.
 * Pure + deterministic so the money path stays auditable.
 */
export function deriveLtvSignals(
  ctx: FeatureCustomerContext | null,
  occurredAtUtc?: string,
): { ltvPaise: number; churnRiskBp: number } {
  const prior = Math.max(0, ctx?.priorSuccessCount ?? 0);
  const ltvPaise = Math.round(prior * ESTIMATED_AVG_TICKET_PAISE);

  const resp = clamp01(ctx?.channelResponsiveness ?? 0.5);
  const optedOut = ctx?.optedOut ? 1 : 0;
  const tenureNorm = ctx?.joinedAtUtc && occurredAtUtc && Number.isFinite(Date.parse(occurredAtUtc))
    ? clamp01(
        Math.max(0, (Date.parse(occurredAtUtc) - Date.parse(ctx.joinedAtUtc)) / 86_400_000) / 400,
      )
    : 0;
  const churn = clamp01((1 - resp) * 0.6 + optedOut * 0.4 - tenureNorm * 0.25);
  return { ltvPaise, churnRiskBp: Math.round(churn * 10_000) };
}

export interface FeatureInput {
  failureCode: string;
  amountPaise: number;
  occurredAtUtc: string;
  /** Strictly-prior failure amounts for this customer, ascending by time. */
  priorFailureAmountsPaise: number[];
  /** Count of this customer's failures strictly before this event. */
  priorFailureCount: number;
  customer?: FeatureCustomerContext | null;
  // ── Payment method details (from Razorpay webhook, decision-time) ──
  paymentMethod?: string;  // card, upi, netbanking, wallet, emi
  cardType?: string;       // credit, debit
  cardEmi?: boolean;       // true if EMI
  isInternational?: boolean; // true if international card
}

export interface ComputedFeatures {
  names: readonly string[];
  values: number[]; // parallel to FEATURE_NAMES
  raw: {
    inferredPaydayDay: number | null;
    paydayObservations: number;
    failureClass: FailureClassV1;
    ltvPaise: number;
    churnRiskBp: number;
    promiseKeptRate: number;
  };
}

export type FailureClassV1 =
  | "SOFT_RETRYABLE"
  | "HARD_METHOD_DEAD"
  | "NETWORK_TIMEOUT"
  | "RISK_FLAGGED"
  | "UNKNOWN";

/**
 * Deterministic code→class mapping. Seeded codes resolve exactly; any foreign
 * code maps to UNKNOWN (fail-closed, invariant I-7).
 */
export function classifyByCode(
  code: string,
  codesByClass: Record<string, readonly string[]>,
): FailureClassV1 {
  const up = code.trim().toUpperCase();
  for (const cls of Object.keys(codesByClass)) {
    if ((codesByClass[cls] ?? []).map((c) => c.toUpperCase()).includes(up)) {
      return cls as FailureClassV1;
    }
  }
  return "UNKNOWN";
}

/**
 * Payday inference: modal day of the success histogram.
 * Returns null when fewer than MIN_OBS successes exist (P2-B7 sentinel path).
 */
export function inferPayday(
  pattern: Record<string, number> | null | undefined,
  minObs = 3,
): { day: number | null; observations: number; confidence: number } {
  if (!pattern) return { day: null, observations: 0, confidence: 0 };
  let total = 0;
  let bestDay: number | null = null;
  let bestCount = 0;
  // Deterministic iteration: numeric-sorted keys.
  const days = Object.keys(pattern)
    .map((k) => Number.parseInt(k, 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  for (const d of days) {
    const n = pattern[String(d)] ?? 0;
    total += n;
    if (n > bestCount || (n === bestCount && bestDay !== null && d < bestDay)) {
      bestCount = n;
      bestDay = d;
    }
  }
  if (total < minObs || bestDay === null) {
    return { day: null, observations: total, confidence: 0 };
  }
  const confidence = Math.min(1, bestCount / total);
  return { day: bestDay, observations: total, confidence };
}

function circularDistance(a: number, b: number, modulus: number): number {
  const d = Math.abs(((a - b) % modulus + modulus) % modulus);
  return Math.min(d, modulus - d);
}

export function computeFeatures(input: FeatureInput): ComputedFeatures {
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new Error(`computeFeatures: amount must be positive integer paise, got ${input.amountPaise}`);
  }
  if (!Number.isFinite(Date.parse(input.occurredAtUtc))) {
    throw new Error(`computeFeatures: invalid occurredAtUtc ${input.occurredAtUtc}`);
  }
  for (const prior of input.priorFailureAmountsPaise) {
    if (!Number.isInteger(prior) || prior <= 0) {
      throw new Error(`computeFeatures: invalid prior amount ${prior}`);
    }
  }
  const cust = input.customer ?? null;

  // §4.7 — behavioral signal: fraction of prior promises-to-pay the customer kept.
  // Surfaced in `raw` (available to the learning loop / narrative). Kept out of the
  // frozen 13-d model vector so the contract + incumbent weights stay intact.
  const promiseKeptRate = clamp01(
    Number.isFinite(cust?.promiseKeptRate ?? NaN) ? (cust?.promiseKeptRate as number) : 0,
  );

  // ── class onehot (code-derived, fail-closed)
  const cls: FailureClassV1 = classifyByCode(input.failureCode, {
    SOFT_RETRYABLE: [
      "INSUFFICIENT_FUNDS",
      "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
      "BAD_REQUEST_PAYMENT_UPI_COLLECT_EXPIRED",
      "BAD_REQUEST_PAYMENT_OTP_VALIDATION_FAILED",
      "TEMPORARY_DECLINE",
      "NO_MANDATE_RESPONSE",
      "LOCAL_INSUFFICIENT_FUNDS",
      "RZP_INSUFFICIENT_FUNDS",
    ],
    HARD_METHOD_DEAD: [
      "CARD_EXPIRED",
      "BAD_REQUEST_PAYMENT_CARD_EXPIRED",
      "BAD_REQUEST_PAYMENT_CARD_INVALID",
      "BAD_REQUEST_PAYMENT_MANDATE_REVOKED",
      "BAD_REQUEST_PAYMENT_UPI_INVALID_VPA",
      "MANDATE_REVOKED",
      "TOKEN_INVALID",
      "LOCAL_EXPIRED_METHOD",
      "LOCAL_INVALID_DETAILS",
      "RZP_EXPIRED_METHOD",
      "RZP_INVALID_DETAILS",
    ],
    NETWORK_TIMEOUT: [
      "GATEWAY_TIMEOUT",
      "GATEWAY_ERROR",
      "BANK_DOWNTIME_NETWORK_ERROR",
      "BAD_REQUEST_PAYMENT_TIMED_OUT",
      "ISSUER_TIMEOUT",
      "NETWORK_ERROR",
      "LOCAL_GATEWAY_TIMEOUT",
      "LOCAL_GATEWAY_503",
      "LOCAL_LOST_RESPONSE",
      "RZP_RATE_LIMITED",
      "RZP_SERVER_ERROR",
    ],
    RISK_FLAGGED: [
      "SUSPECTED_FRAUD",
      "BAD_REQUEST_PAYMENT_FRAUD_IDENTIFIED",
      "BAD_REQUEST_PAYMENT_CARD_STOLEN",
      "RISK_BLOCKED",
      "LOCAL_RISK_REJECTED",
      "RZP_REJECTED",
    ],
    UNKNOWN: [
      "BAD_REQUEST_PAYMENT_DECLINED_BY_BANK",
      "UNKNOWN_CODE",
      "UNKNOWN",
    ],
  });


  // ── payday proximity from noisy histogram (never from ground truth)
  const pay = inferPayday(cust?.paydayPattern ?? null);
  const domMs = new Date(input.occurredAtUtc).getUTCDate();
  const nearPayday =
    pay.day !== null && circularDistance(domMs, pay.day, 31) <= 2 ? 1 : 0;

  // ── amount z-score vs STRICTLY PRIOR failures (decision-time safe)
  let amountZ = 0;
  if (input.priorFailureAmountsPaise.length >= 2) {
    const sorted = [...input.priorFailureAmountsPaise].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 1
        ? (sorted[mid] as number)
        : Math.round((((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2));
    if (median > 0) {
      // Robust-ish scale: mean absolute deviation from median, floor 1 rupee.
      const mad =
        input.priorFailureAmountsPaise.reduce(
          (s, v) => s + Math.abs(v - median),
          0,
        ) / input.priorFailureAmountsPaise.length;
      amountZ = (input.amountPaise - median) / Math.max(mad, 100);
      if (!Number.isFinite(amountZ)) amountZ = 0;
      amountZ = Math.max(-5, Math.min(5, amountZ));
    }
  }

  const tenureDays = cust?.joinedAtUtc
    ? Math.max(
        0,
        (Date.parse(input.occurredAtUtc) - Date.parse(cust.joinedAtUtc)) / 86_400_000,
      )
    : 0;

  const ltv = deriveLtvSignals(cust, input.occurredAtUtc);

  const daysSinceLastAttempt = input.priorFailureAmountsPaise.length > 0 ? 1 : 0;
  const highValueTier = input.amountPaise >= 1_000_000 ? 1 : 0;
  const bankRailHealth = 1.0;

  // ── Payment method features (decision-time, no leakage)
  const method = (input.paymentMethod || "").toLowerCase();
  const isCard = method === "card" ? 1 : 0;
  const isUpi = method === "upi" ? 1 : 0;
  const isNetbanking = method === "netbanking" ? 1 : 0;
  const isWallet = method === "wallet" ? 1 : 0;
  const isEmi = input.cardEmi ? 1 : 0;
  const isDebitCard = isCard && (input.cardType || "").toLowerCase() === "debit" ? 1 : 0;
  const isInternational = input.isInternational ? 1 : 0;

  const values = [
    ONEHOT_CLASSES.includes(cls as (typeof ONEHOT_CLASSES)[number]) &&
    cls === "SOFT_RETRYABLE"
      ? 1
      : 0,
    cls === "HARD_METHOD_DEAD" ? 1 : 0,
    cls === "NETWORK_TIMEOUT" ? 1 : 0,
    cls === "RISK_FLAGGED" ? 1 : 0,
    nearPayday,
    pay.confidence,
    amountZ,
    Math.min(1, (cust?.priorSuccessCount ?? 0) / 8),
    Math.min(1, input.priorFailureCount / 5),
    cust?.channelResponsiveness ?? 0.5,
    Math.min(1, tenureDays / 400),
    clamp01(ltv.ltvPaise / LTV_NORM_PAISE),
    ltv.churnRiskBp / 10_000,
    Math.min(1, daysSinceLastAttempt / 30),
    highValueTier,
    bankRailHealth,
    // Payment method features
    isCard,
    isUpi,
    isNetbanking,
    isWallet,
    isEmi,
    isDebitCard,
    isInternational,
  ];


  if (values.some((v) => !Number.isFinite(v))) {
    throw new Error(`computeFeatures produced non-finite value for ${input.failureCode}`);
  }

  return {
    names: FEATURE_NAMES,
    values,
    raw: {
      inferredPaydayDay: pay.day,
      paydayObservations: pay.observations,
      failureClass: cls,
      ltvPaise: ltv.ltvPaise,
      churnRiskBp: ltv.churnRiskBp,
      promiseKeptRate,
    },
  };
}

/** Stable hash used for customer-split bucketing (leakage-safe partitioning). */
export function customerBucket(customerId: string): number {
  return hashSeed(customerId) % 1000;
}
