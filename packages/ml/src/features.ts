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
import { hashSeed } from "@arbiter/shared";

export const FEATURE_VERSION = "feat-v1";

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
}

export interface ComputedFeatures {
  names: readonly string[];
  values: number[]; // parallel to FEATURE_NAMES
  raw: {
    inferredPaydayDay: number | null;
    paydayObservations: number;
    failureClass: FailureClassV1;
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

  // ── class onehot (code-derived, fail-closed)
  const cls: FailureClassV1 = classifyByCode(input.failureCode, {
    SOFT_RETRYABLE: ["INSUFFICIENT_FUNDS", "TEMPORARY_DECLINE", "NO_MANDATE_RESPONSE"],
    HARD_METHOD_DEAD: ["CARD_EXPIRED", "MANDATE_REVOKED", "TOKEN_INVALID"],
    NETWORK_TIMEOUT: ["GATEWAY_TIMEOUT", "ISSUER_TIMEOUT", "NETWORK_ERROR"],
    RISK_FLAGGED: ["SUSPECTED_FRAUD", "RISK_BLOCKED"],
    UNKNOWN: ["UNKNOWN_CODE"],
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
    },
  };
}

/** Stable hash used for customer-split bucketing (leakage-safe partitioning). */
export function customerBucket(customerId: string): number {
  return hashSeed(customerId) % 1000;
}
