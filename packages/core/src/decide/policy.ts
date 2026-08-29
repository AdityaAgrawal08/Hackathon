/**
 * Policy pack v1 — strict, fail-closed configuration (bug P3-B7).
 * Unknown keys are BOOT ERRORS, not silent no-ops; constraint evaluation
 * collects ALL violated rules (never short-circuits) so refusal records can
 * list every matched rule (bug P3-B3).
 */
import { z } from "zod";
import { QUIET_START_MIN, QUIET_END_MIN, istMinuteOfDay } from "@arbiter/shared";
import type { FailureClassId } from "./catalog.js";

export const POLICY_VERSION = "policy-v1";

/**
 * Regulatory profile (§4.3) — India-specific, fail-closed guardrails that encode
 * RBI / NPCI / DPDP / TRAI rules as live constraints. A neutral recovery agent
 * can ship these as a programmable layer a single foreign PSP cannot (they
 * hardcode NPCI rules and cannot expose them for merchant audit).
 */
export const regulatorySchema = z
  .object({
    /** Only India is supported (RBI/NPCI jurisdiction). */
    jurisdiction: z.literal("IN"),
    /** Recurring mandate type, if any. Drives NPCI retry + pre-debit rules. */
    mandate_type: z.enum(["UPI_AUTOPAY", "CARD_AUTOPAY", "NONE"]),
    /** DPDP 2023 consent state for processing customer PI in recovery. */
    dpdp_consent_status: z.enum(["GRANTED", "LAPSED", "NOT_GIVEN"]),
    /** NPCI 1+3 ceiling: max debit attempts per mandate in a cycle. */
    autopay_retry_ceiling: z.number().int().min(0).max(10),
    /** NPCI pre-debit notice window (hours) before a scheduled debit. */
    pre_debit_notice_hours: z.number().int().min(0).max(72),
    /** TRAI DLT template id for the recovery SMS/WhatsApp (audit). */
    trai_dlt_template_id: z.string().optional(),
  })
  .strict();

export const policySchema = z
  .object({
    policy_version: z.literal(POLICY_VERSION),
    /** Minimum adjusted recovery probability (basis points) for contact actions. */
    confidence_floor_bp: z.number().int().min(0).max(10_000),
    /** Retry attempts allowed per billing cycle before contact actions are blocked. */
    max_attempts_per_cycle: z.number().int().min(0).max(10),
    /** Minimum hours between customer contacts. */
    min_interval_hours: z.number().int().min(0).max(24 * 30),
    /** IST minute-of-day window [start, end); may cross midnight. */
    quiet_hours: z.object({
      start_minute: z.number().int().min(0).max(1439),
      end_minute: z.number().int().min(0).max(1440),
    }),
    /** Single-proposal amount ceiling in integer paise. */
    exposure_cap_paise: z.number().int().min(1),
    /** Classes that may ONLY route to HUMAN_REVIEW / NO_ACTION. */
    human_review_classes: z.array(z.enum(["SOFT_RETRYABLE", "HARD_METHOD_DEAD", "NETWORK_TIMEOUT", "RISK_FLAGGED", "UNKNOWN"])),
    /** §4.3 regulatory guardrails (RBI / NPCI / DPDP / TRAI). */
    regulatory_profile: regulatorySchema,
  })
  .strict();

export type PolicyPack = z.infer<typeof policySchema>;

export function defaultPolicy(): PolicyPack {
  return {
    policy_version: POLICY_VERSION,
    confidence_floor_bp: 2_000,
    max_attempts_per_cycle: 2,
    min_interval_hours: 24,
    quiet_hours: { start_minute: QUIET_START_MIN, end_minute: QUIET_END_MIN },
    exposure_cap_paise: 10_000_000,
    human_review_classes: ["RISK_FLAGGED", "UNKNOWN"],
    regulatory_profile: {
      jurisdiction: "IN",
      mandate_type: "NONE",
      dpdp_consent_status: "GRANTED",
      autopay_retry_ceiling: 3,
      pre_debit_notice_hours: 24,
      trai_dlt_template_id: "rzp_recovery_dl",
    },
  };
}

/** Strict parse — throws a boot error on unknown keys or bad values (P3-B7). */
export function parsePolicyPack(input: unknown): PolicyPack {
  return policySchema.parse(input);
}

/** Rule identifiers emitted by evaluateConstraints — stable for ledger REFUSAL rows. */
export type RuleId =
  | "OPTED_OUT"
  | "QUIET_HOURS"
  | "ATTEMPT_CAP"
  | "MIN_INTERVAL"
  | "EXPOSURE_CAP"
  | "CONFIDENCE_FLOOR"
  | "HUMAN_REVIEW_CLASS"
  | "PAYDAY_UNKNOWN"
  | "CONSENT_LAPSED"
  | "AUTOPAY_RETRY_CEILING"
  | "PRE_DEBIT_NOTICE";

export interface ConstraintContext {
  failureClass: FailureClassId;
  amountPaise: number;
  probabilityBp: number;
  nowMs: number;
  attemptsSoFar: number;
  lastContactAtMs: number | null;
  customerOptedOut: boolean;
  isContactAction: boolean;
  paydayKnown: boolean;
  /** The action being evaluated (needed for NPCI pre-debit / retry rules). */
  actionId: string;
}

export function evaluateConstraints(policy: PolicyPack, ctx: ConstraintContext): RuleId[] {
  const violations: RuleId[] = [];

  if (ctx.customerOptedOut) violations.push("OPTED_OUT");

  // DPDP 2023 — consent to process personal data for recovery lapsed/not given.
  // This is a HARD refusal for every recovery action (incl. HUMAN_REVIEW, which
  // would still access PI); only NO_ACTION is exempt. Placed before the
  // contact-action early-return so non-contact recovery actions are covered.
  if (policy.regulatory_profile.dpdp_consent_status !== "GRANTED" && ctx.actionId !== "NO_ACTION") {
    violations.push("CONSENT_LAPSED");
  }

  if (!ctx.isContactAction) return violations;
  if (policy.human_review_classes.includes(ctx.failureClass)) {
    violations.push("HUMAN_REVIEW_CLASS");
  }
  if (!ctx.paydayKnown) violations.push("PAYDAY_UNKNOWN");

  return violations.concat(evaluateContactRules(policy, ctx));
}

function evaluateContactRules(policy: PolicyPack, ctx: ConstraintContext): RuleId[] {
  const violations: RuleId[] = [];
  const minute = istMinuteOfDay(ctx.nowMs);
  const { start_minute: s, end_minute: e } = policy.quiet_hours;
  const quiet = s === e ? false : s < e ? minute >= s && minute < e : minute >= s || minute < e;
  if (quiet) violations.push("QUIET_HOURS");

  if (ctx.attemptsSoFar >= policy.max_attempts_per_cycle) violations.push("ATTEMPT_CAP");

  if (
    ctx.lastContactAtMs !== null &&
    ctx.nowMs - ctx.lastContactAtMs < policy.min_interval_hours * 3_600_000
  ) {
    violations.push("MIN_INTERVAL");
  }

  if (ctx.amountPaise > policy.exposure_cap_paise) violations.push("EXPOSURE_CAP");
  if (ctx.probabilityBp < policy.confidence_floor_bp) violations.push("CONFIDENCE_FLOOR");

  return violations.concat(evaluateRegulatoryRules(policy, ctx));
}

/**
 * §4.3 regulatory guardrails. These are HARD refusals — merchant autonomy
 * cannot override them (fail-closed: a missing/odd profile is treated as the
 * strictest Indian default by the caller). Levels:
 *   CONSENT_LAPSED       — DPDP 2023: no consent ⇒ no PI processing for recovery
 *   AUTOPAY_RETRY_CEILING— NPCI 1+3: no more than N debit attempts per mandate
 *   PRE_DEBIT_NOTICE     — NPCI: an immediate (RETRY_NOW) debit on an autopay
 *                          mandate needs ≥ pre_debit_notice_hours notice
 */
function evaluateRegulatoryRules(policy: PolicyPack, ctx: ConstraintContext): RuleId[] {
  const reg = policy.regulatory_profile;
  const violations: RuleId[] = [];

  // DPDP 2023 — consent to process personal data for recovery lapsed/not given.
  if (reg.dpdp_consent_status !== "GRANTED") {
    violations.push("CONSENT_LAPSED");
  }

  const isAutopay = reg.mandate_type === "UPI_AUTOPAY" || reg.mandate_type === "CARD_AUTOPAY";
  if (isAutopay) {
    // NPCI 1+3: cap debit attempts per mandate cycle.
    if (ctx.attemptsSoFar >= reg.autopay_retry_ceiling) {
      violations.push("AUTOPAY_RETRY_CEILING");
    }
    // NPCI pre-debit notice: an immediate retry (RETRY_NOW) charges without the
    // mandated advance notice → refused; scheduled retries (RETRY_PAYDAY) are OK.
    if (ctx.actionId === "RETRY_NOW") {
      violations.push("PRE_DEBIT_NOTICE");
    }
  }

  return violations;
}
