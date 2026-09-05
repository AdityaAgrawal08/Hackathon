/**
 * Autonomous Reflection & Multi-Step Escalation Engine (Track 3)
 *
 * Implements closed-loop: Perceive -> Plan -> Act -> Observe -> Reflect -> Adapt
 *
 * When an initial recovery attempt does not convert within the observation window,
 * this engine observes the non-response, reflects on customer state and channel history,
 * and plans a bounded, compliant stage-2 adaptation.
 */

import { isoUtc } from "@arbiter/shared";
import { defaultMarginGuard } from "./margin_guard.js";
import { isQuietHoursIST } from "../decide/window.js";
import type { FailureClassId } from "../decide/catalog.js";

export interface PendingEventState {
  eventId: string;
  customerProfileId: string;
  amountPaise: number;
  failureClass: FailureClassId;
  initialChannel: "SMS" | "EMAIL";
  initialDispatchedAtUtc: string;
  portalViewed: boolean;
  portalExitedWithoutPay: boolean;
  touchCount: number;
  optedOut: boolean;
}

export interface ReflectionDecision {
  shouldEscalate: boolean;
  nextChannel?: "SMS" | "EMAIL";
  adaptationStrategy: "CHANNEL_SWITCH" | "DOWNSELL_DISCOUNT" | "ALTERNATE_UPI" | "HOLD_QUIET_HOURS" | "SUPPRESS_FATIGUE" | "HUMAN_REVIEW";
  suggestedDiscountBps?: number;
  safeAmountPaise?: number;
  reason: string;
}

export class ReflectionEngine {
  /**
   * Observes event status and reflects on next autonomous action.
   */
  reflect(event: PendingEventState, nowMs: number = Date.now()): ReflectionDecision {
    // 1. Guardrail: Opt-out / Stop
    if (event.optedOut) {
      return {
        shouldEscalate: false,
        adaptationStrategy: "SUPPRESS_FATIGUE",
        reason: "Customer has opted out of communications.",
      };
    }

    // 2. Guardrail: Fatigue Cap (Max 3 touches per 24h)
    if (event.touchCount >= 3) {
      return {
        shouldEscalate: false,
        adaptationStrategy: "SUPPRESS_FATIGUE",
        reason: "Customer reached maximum 3 touches per 24-hour window.",
      };
    }

    // 3. Guardrail: TRAI Quiet Hours
    if (isQuietHoursIST(nowMs)) {
      return {
        shouldEscalate: false,
        adaptationStrategy: "HOLD_QUIET_HOURS",
        reason: "Currently within TRAI quiet hours (21:00-09:00 IST). Hold escalation until 09:01 IST.",
      };
    }

    // 4. Case: Customer visited portal and exited without paying (Exit-intent behavioral signal)
    if (event.portalExitedWithoutPay || (event.portalViewed && event.failureClass === "SOFT_RETRYABLE")) {
      // Propose downsell discount bounded by MarginGuard (default 10% discount, max 15%)
      const discountBps = 1000;
      const safeAmount = defaultMarginGuard.computeSafeDownsellPaise(event.amountPaise, discountBps);

      return {
        shouldEscalate: true,
        nextChannel: event.initialChannel === "SMS" ? "EMAIL" : "SMS",
        adaptationStrategy: "DOWNSELL_DISCOUNT",
        suggestedDiscountBps: discountBps,
        safeAmountPaise: safeAmount,
        reason: "Customer showed intent by viewing portal but experienced payment resistance. Triggering bounded downsell.",
      };
    }

    // 5. Case: Initial outreach unread/unclicked after observation window -> Switch channel
    const initialTimeMs = new Date(event.initialDispatchedAtUtc).getTime();
    const elapsedMinutes = (nowMs - initialTimeMs) / 60000;

    // Minimum observation window: 15 mins for SMS, 60 mins for Email
    const minWaitMins = event.initialChannel === "SMS" ? 15 : 60;
    if (elapsedMinutes < minWaitMins) {
      return {
        shouldEscalate: false,
        adaptationStrategy: "HOLD_QUIET_HOURS",
        reason: `Still within observation window (${Math.round(elapsedMinutes)}m elapsed / ${minWaitMins}m window).`,
      };
    }

    // Channel Escalation / Switch
    const nextChannel = event.initialChannel === "SMS" ? "EMAIL" : "SMS";
    return {
      shouldEscalate: true,
      nextChannel,
      adaptationStrategy: "CHANNEL_SWITCH",
      safeAmountPaise: event.amountPaise,
      reason: `No conversion observed on ${event.initialChannel} after ${Math.round(elapsedMinutes)} minutes. Autonomously switching to ${nextChannel}.`,
    };
  }
}

export const defaultReflectionEngine = new ReflectionEngine();
