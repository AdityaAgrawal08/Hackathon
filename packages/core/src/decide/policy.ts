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
  | "PAYDAY_UNKNOWN";

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
}

export function evaluateConstraints(policy: PolicyPack, ctx: ConstraintContext): RuleId[] {
  const violations: RuleId[] = [];

  if (ctx.customerOptedOut) violations.push("OPTED_OUT");
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

  return violations;
}
