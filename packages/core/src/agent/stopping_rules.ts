/**
 * Non-Negotiable Mathematical Stopping Rules & Compliance Invariants
 * Protects merchants against customer harassment, COGS bleed, and regulatory penalties.
 */
import { isQuietHoursIST, IST_OFFSET_MS } from "../decide/window.js";

export interface StoppingRuleContext {
  touchCount: number;
  lastTouchAtUtc?: string;
  isOptedOut: boolean;
  createdAtUtc: string;
  domain: "D2C_CHECKOUT" | "SAAS_MANDATE" | "B2B_INVOICE";
  nowMs?: number;
  isPortalSession?: boolean;
}

export interface StoppingRuleEvaluation {
  allowed: boolean;
  reason?: "FREQUENCY_CEILING_EXCEEDED" | "COOLDOWN_ACTIVE" | "TRAI_QUIET_HOURS" | "OPTED_OUT" | "TEMPORAL_EXPIRED";
  nextPermittedAtUtc?: string;
  cooldownRemainingMinutes?: number;
}

const MAX_TOUCHES = 3;
const MIN_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours

const DOMAIN_EXPIRY_MS = {
  D2C_CHECKOUT: 72 * 60 * 60 * 1000,   // 72 hours
  SAAS_MANDATE: 7 * 24 * 60 * 60 * 1000, // 7 days
  B2B_INVOICE: 35 * 24 * 60 * 60 * 1000, // 35 days
};

/**
 * Evaluates whether an automated intervention is permitted under all 5 hard guards.
 */
export function evaluateStoppingRules(ctx: StoppingRuleContext): StoppingRuleEvaluation {
  const nowMs = ctx.nowMs || Date.now();

  // Rule 1: Opt-out Kill Switch
  if (ctx.isOptedOut) {
    return {
      allowed: false,
      reason: "OPTED_OUT",
    };
  }

  // Rule 2: Frequency Ceiling (Max 3 Touches)
  if (ctx.touchCount >= MAX_TOUCHES) {
    return {
      allowed: false,
      reason: "FREQUENCY_CEILING_EXCEEDED",
    };
  }

  // Rule 3: Temporal Expiration
  const createdMs = new Date(ctx.createdAtUtc).getTime();
  const maxLifetimeMs = DOMAIN_EXPIRY_MS[ctx.domain] || DOMAIN_EXPIRY_MS.D2C_CHECKOUT;
  if (nowMs - createdMs > maxLifetimeMs) {
    return {
      allowed: false,
      reason: "TEMPORAL_EXPIRED",
    };
  }

  // Rule 4: Cooldown Floor (Min 4h between touches) - applies to outbound pushes
  if (!ctx.isPortalSession && ctx.lastTouchAtUtc) {
    const lastTouchMs = new Date(ctx.lastTouchAtUtc).getTime();
    const elapsedMs = nowMs - lastTouchMs;
    if (elapsedMs < MIN_COOLDOWN_MS) {
      const remainingMs = MIN_COOLDOWN_MS - elapsedMs;
      return {
        allowed: false,
        reason: "COOLDOWN_ACTIVE",
        cooldownRemainingMinutes: Math.ceil(remainingMs / (60 * 1000)),
        nextPermittedAtUtc: new Date(lastTouchMs + MIN_COOLDOWN_MS).toISOString(),
      };
    }
  }

  // Rule 5: TRAI Quiet Hours (21:00 - 09:00 IST) - applies to outbound telecom dunning
  if (!ctx.isPortalSession && isQuietHoursIST(nowMs)) {
    const istDate = new Date(nowMs + IST_OFFSET_MS);
    const nextMorningIST = new Date(nowMs + IST_OFFSET_MS);
    if (istDate.getUTCHours() >= 21) {
      nextMorningIST.setUTCDate(nextMorningIST.getUTCDate() + 1);
    }
    nextMorningIST.setUTCHours(9, 0, 0, 0);
    const nextAllowedMs = nextMorningIST.getTime() - IST_OFFSET_MS;
    return {
      allowed: false,
      reason: "TRAI_QUIET_HOURS",
      nextPermittedAtUtc: new Date(nextAllowedMs).toISOString(),
    };
  }

  return { allowed: true };
}
