/**
 * Autonomous Dynamic Re-Planning Agent
 *
 * Replaces static single-shot dunning with an autonomous perception-action loop.
 * Ingests real-time customer behavior (portal open, dwell time, exit without pay, secondary decline)
 * and deterministically re-plans the next optimal recovery action.
 */
import { evaluateStoppingRules, type StoppingRuleContext } from "./stopping_rules.js";
import {
  LinUCBBandit,
  defaultRecoveryBandit,
  type ArmSelectionResult,
} from "./contextual_bandit.js";

export type InteractionType =
  | "SMS_DELIVERED"
  | "EMAIL_DELIVERED"
  | "PORTAL_OPENED"
  | "PORTAL_EXITED_NO_PAY"
  | "PAYMENT_ATTEMPTED_FAILED"
  | "CUSTOMER_OPT_OUT";

export interface CustomerInteractionEvent {
  eventId: string;
  interactionType: InteractionType;
  timeSinceFailureMinutes: number;
  dwellTimeSeconds?: number;
  failedPaymentMethod?: string;
  cartAmountPaise?: number;
  nowMs?: number;
}

export interface RePlanOptions {
  enableWhatsApp?: boolean; // When false, strictly cascades between SMS <-> Email (default: true for legacy compatibility)
}

export interface AgentRePlanResult {
  action:
    | "NO_ACTION"
    | "SWITCH_TO_WHATSAPP"
    | "SWITCH_TO_EMAIL"
    | "SWITCH_TO_SMS"
    | "TRIGGER_DOWNSELL_SPLIT"
    | "SWITCH_TO_1TAP_UPI"
    | "TERMINATE_STOP_RULE"
    | "NOTIFY_VENDOR_STALLED";
  reason: string;
  concessionType?: "SPLIT_PAY" | "INSTANT_DISCOUNT_5PCT";
  concessionPaise?: number;
  scheduledAtUtc?: string;
  banditSelection?: ArmSelectionResult<any>;
}

/**
 * Evaluates dynamic customer behavioral telemetry and re-plans next action using
 * the regret-bounded LinUCB contextual bandit bounded by 5 hard stopping rules.
 */
export function rePlanRecoveryAction(
  event: CustomerInteractionEvent,
  stoppingCtx: StoppingRuleContext,
  bandit: LinUCBBandit<any> = defaultRecoveryBandit,
  options?: RePlanOptions,
): AgentRePlanResult {
  const nowMs = event.nowMs || Date.now();

  // 1. Immediate Opt-Out
  if (event.interactionType === "CUSTOMER_OPT_OUT") {
    return {
      action: "TERMINATE_STOP_RULE",
      reason: "Customer triggered explicit opt-out (STOP/DND). Immediate suppression.",
    };
  }

  // 2. Check Stopping Rules
  const isPortalInteraction =
    event.interactionType === "PORTAL_EXITED_NO_PAY" ||
    event.interactionType === "PORTAL_OPENED" ||
    event.interactionType === "PAYMENT_ATTEMPTED_FAILED";

  const stoppingEval = evaluateStoppingRules({
    ...stoppingCtx,
    isPortalSession: stoppingCtx.isPortalSession ?? isPortalInteraction,
    nowMs,
  });
  if (!stoppingEval.allowed) {
    return {
      action: "NO_ACTION",
      reason: `Action suppressed by compliance guard: ${stoppingEval.reason}. Next permitted: ${stoppingEval.nextPermittedAtUtc || "Never"}`,
      scheduledAtUtc: stoppingEval.nextPermittedAtUtc,
    };
  }

  const amountPaise = event.cartAmountPaise || 499900;
  const isEnterprise = (bandit as any)?.dimension === 5;
  const context = isEnterprise
    ? LinUCBBandit.buildEnterpriseContext(
        amountPaise,
        event.dwellTimeSeconds || 0,
        event.timeSinceFailureMinutes || 30,
        stoppingCtx.touchCount,
        0.6
      )
    : LinUCBBandit.buildContext(
        amountPaise,
        stoppingCtx.touchCount,
        event.dwellTimeSeconds || 0,
        0.6
      );
  const banditSelection = bandit.selectArm(context as any);

  // 3. Scenario A: Portal Exited without Pay after viewing (> 20s dwell)
  // High friction / sticker shock -> Autonomous Downsell / Split-Pay Concession
  if (event.interactionType === "PORTAL_EXITED_NO_PAY" && (event.dwellTimeSeconds || 0) >= 20) {
    if (amountPaise >= 199900) {
      // Split into 3 installments
      const splitAmount = Math.round(amountPaise / 3);
      return {
        action: "TRIGGER_DOWNSELL_SPLIT",
        reason: `Customer viewed portal for ${event.dwellTimeSeconds}s and dropped off (LinUCB score ${banditSelection.ucbScore}). Triggering 3x Split-Pay (₹${(splitAmount / 100).toFixed(0)}/mo) to eliminate friction.`,
        concessionType: "SPLIT_PAY",
        concessionPaise: splitAmount,
        banditSelection,
      };
    } else {
      // 5% instant discount
      const discountPaise = Math.round(amountPaise * 0.05);
      return {
        action: "TRIGGER_DOWNSELL_SPLIT",
        reason: `Customer viewed portal for ${event.dwellTimeSeconds}s and dropped off (LinUCB score ${banditSelection.ucbScore}). Triggering 5% instant checkout concession.`,
        concessionType: "INSTANT_DISCOUNT_5PCT",
        concessionPaise: discountPaise,
        banditSelection,
      };
    }
  }

  // 4. Scenario B: Secondary Card Payment Failed inside Recovery Portal
  // Card limit / 3DS dropped -> Switch to 1-Tap UPI Intent
  if (event.interactionType === "PAYMENT_ATTEMPTED_FAILED") {
    return {
      action: "SWITCH_TO_1TAP_UPI",
      reason: "Secondary card attempt declined in portal. Automatically promoting 1-Tap Mobile UPI Intent.",
      banditSelection,
    };
  }

  // 5. Scenario C: Unopened SMS / Email after 2 hours during active business window
  if (
    (event.interactionType === "SMS_DELIVERED" || event.interactionType === "EMAIL_DELIVERED") &&
    event.timeSinceFailureMinutes >= 120
  ) {
    if (options?.enableWhatsApp === false) {
      if (event.interactionType === "SMS_DELIVERED") {
        return {
          action: "SWITCH_TO_EMAIL",
          reason: "Primary SMS unopened after 2h. Cross-channel failover to transactional Email notification.",
          banditSelection,
        };
      } else {
        return {
          action: "SWITCH_TO_SMS",
          reason: "Primary Email unopened after 2h. Cross-channel failover to urgent SMS notification.",
          banditSelection,
        };
      }
    }

    return {
      action: "SWITCH_TO_WHATSAPP",
      reason: "Primary notification unopened after 2h. Channel-switching to high-open WhatsApp utility notification.",
      banditSelection,
    };
  }

  return {
    action: "NO_ACTION",
    reason: "Interaction observed. User within standard active consideration window.",
    banditSelection,
  };
}
