/**
 * Autonomous Dynamic Re-Planning Agent
 *
 * Replaces static single-shot dunning with an autonomous perception-action loop.
 * Ingests real-time customer behavior (portal open, dwell time, exit without pay, secondary decline)
 * and deterministically re-plans the next optimal recovery action.
 */
import { evaluateStoppingRules, type StoppingRuleContext } from "./stopping_rules.js";

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

export interface AgentRePlanResult {
  action:
    | "NO_ACTION"
    | "SWITCH_TO_WHATSAPP"
    | "TRIGGER_DOWNSELL_SPLIT"
    | "SWITCH_TO_1TAP_UPI"
    | "TERMINATE_STOP_RULE"
    | "NOTIFY_VENDOR_STALLED";
  reason: string;
  concessionType?: "SPLIT_PAY" | "INSTANT_DISCOUNT_5PCT";
  concessionPaise?: number;
  scheduledAtUtc?: string;
}

/**
 * Evaluates dynamic customer behavioral telemetry and re-plans next action.
 */
export function rePlanRecoveryAction(
  event: CustomerInteractionEvent,
  stoppingCtx: StoppingRuleContext,
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
  const stoppingEval = evaluateStoppingRules({ ...stoppingCtx, nowMs });
  if (!stoppingEval.allowed) {
    return {
      action: "NO_ACTION",
      reason: `Action suppressed by compliance guard: ${stoppingEval.reason}. Next permitted: ${stoppingEval.nextPermittedAtUtc || "Never"}`,
      scheduledAtUtc: stoppingEval.nextPermittedAtUtc,
    };
  }

  const amountPaise = event.cartAmountPaise || 499900;

  // 3. Scenario A: Portal Exited without Pay after viewing (> 20s dwell)
  // High friction / sticker shock -> Autonomous Downsell / Split-Pay Concession
  if (event.interactionType === "PORTAL_EXITED_NO_PAY" && (event.dwellTimeSeconds || 0) >= 20) {
    if (amountPaise >= 199900) {
      // Split into 3 installments
      const splitAmount = Math.round(amountPaise / 3);
      return {
        action: "TRIGGER_DOWNSELL_SPLIT",
        reason: `Customer viewed portal for ${event.dwellTimeSeconds}s and dropped off. Triggering 3x Split-Pay (₹${(splitAmount / 100).toFixed(0)}/mo) to eliminate friction.`,
        concessionType: "SPLIT_PAY",
        concessionPaise: splitAmount,
      };
    } else {
      // 5% instant discount
      const discountPaise = Math.round(amountPaise * 0.05);
      return {
        action: "TRIGGER_DOWNSELL_SPLIT",
        reason: `Customer viewed portal for ${event.dwellTimeSeconds}s and dropped off. Triggering 5% instant checkout concession.`,
        concessionType: "INSTANT_DISCOUNT_5PCT",
        concessionPaise: discountPaise,
      };
    }
  }

  // 4. Scenario B: Secondary Card Payment Failed inside Recovery Portal
  // Card limit / 3DS dropped -> Switch to 1-Tap UPI Intent
  if (event.interactionType === "PAYMENT_ATTEMPTED_FAILED") {
    return {
      action: "SWITCH_TO_1TAP_UPI",
      reason: "Secondary card attempt declined in portal. Automatically promoting 1-Tap Mobile UPI Intent.",
    };
  }

  // 5. Scenario C: Unopened SMS / Email after 2 hours during active business window
  if (
    (event.interactionType === "SMS_DELIVERED" || event.interactionType === "EMAIL_DELIVERED") &&
    event.timeSinceFailureMinutes >= 120
  ) {
    return {
      action: "SWITCH_TO_WHATSAPP",
      reason: "Primary notification unopened after 2h. Channel-switching to high-open WhatsApp utility notification.",
    };
  }

  return {
    action: "NO_ACTION",
    reason: "Interaction observed. User within standard active consideration window.",
  };
}
