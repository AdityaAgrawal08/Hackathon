/**
 * Razorpay provider — constructs real Payment Link / UPI Autopay retry payloads.
 *
 * Mode (via env REAL_EXECUTION_MODE):
 *   - "dry-run" (default): constructs payload, logs it, returns mock outcome.
 *   - "live": actually calls Razorpay API (requires RAZORPAY_KEY_ID/SECRET).
 *
 * Action → Razorpay mapping:
 *   RETRY_NOW       → Payment Link (card/UPI) for immediate retry
 *   RETRY_PAYDAY    → UPI Autopay retry scheduled at payday window
 *   ALTERNATE_UPI_LINK → UPI Intent/Collect link for alternative method
 *   REMINDER_LINK   → Payment Link with custom message
 *   HUMAN_REVIEW    → No API call; returns AMBIGUOUS
 */
import { ActionProvider, ProviderContext, ProviderResult, ExecutionOutcome } from "./types.js";

const MODE = process.env.REAL_EXECUTION_MODE ?? "dry-run";
const IS_LIVE = MODE === "live";

function buildPaymentLinkPayload(ctx: ProviderContext) {
  const amountRupees = (ctx.amountPaise / 100).toFixed(2);
  return {
    amount: ctx.amountPaise,
    currency: "INR",
    accept_partial: false,
    description: `Recovery retry for ${ctx.actionId} — ${ctx.failureClass}`,
    customer: { contact: "+919999999999", email: "customer@example.com" },
    notify: { sms: true, email: true },
    reminder_enable: true,
    notes: {
      proposal_id: ctx.proposalId,
      action: ctx.actionId,
      failure_class: ctx.failureClass,
      idempotency_key: ctx.idempotencyKey,
    },
    callback_url: "https://example.com/callback",
    callback_method: "get",
  };
}

function buildUpiAutopayRetryPayload(ctx: ProviderContext) {
  return {
    amount: ctx.amountPaise,
    currency: "INR",
    payment_capture: 1,
    order_id: `order_${ctx.proposalId}`,
    method: "upi",
    upi: { flow: "collect", vpa: "customer@upi" },
    notes: {
      proposal_id: ctx.proposalId,
      action: ctx.actionId,
      failure_class: ctx.failureClass,
      idempotency_key: ctx.idempotencyKey,
      scheduled_for: "payday_window",
    },
  };
}

function buildAlternateUpiLinkPayload(ctx: ProviderContext) {
  return {
    amount: ctx.amountPaise,
    currency: "INR",
    description: `Alternative UPI retry for ${ctx.actionId}`,
    method: "upi",
    upi: { flow: "intent", vpa: "customer@upi" },
    notes: {
      proposal_id: ctx.proposalId,
      action: ctx.actionId,
      failure_class: ctx.failureClass,
      idempotency_key: ctx.idempotencyKey,
      alternate_method: true,
    },
  };
}

function buildReminderLinkPayload(ctx: ProviderContext) {
  const amountRupees = (ctx.amountPaise / 100).toFixed(2);
  return {
    amount: ctx.amountPaise,
    currency: "INR",
    accept_partial: false,
    description: `Reminder: payment of ₹${amountRupees} due`,
    customer: { contact: "+919999999999", email: "customer@example.com" },
    notify: { sms: true, email: true, whatsapp: true },
    notes: {
      proposal_id: ctx.proposalId,
      action: ctx.actionId,
      failure_class: ctx.failureClass,
      idempotency_key: ctx.idempotencyKey,
      reminder: true,
    },
  };
}

function buildPayload(ctx: ProviderContext) {
  switch (ctx.actionId) {
    case "RETRY_NOW":
      return buildPaymentLinkPayload(ctx);
    case "RETRY_PAYDAY":
      return buildUpiAutopayRetryPayload(ctx);
    case "ALTERNATE_UPI_LINK":
      return buildAlternateUpiLinkPayload(ctx);
    case "REMINDER_LINK":
      return buildReminderLinkPayload(ctx);
    default:
      return { notes: { proposal_id: ctx.proposalId, action: ctx.actionId } };
  }
}

function mockOutcome(actionId: string): ExecutionOutcome {
  if (actionId === "HUMAN_REVIEW") return "AMBIGUOUS";
  // In dry-run, viable actions succeed
  return actionId === "HUMAN_REVIEW" ? "AMBIGUOUS" : "SUCCEEDED";
}

export const razorpayProvider: ActionProvider = {
  name: `razorpay-${MODE}`,
  isLive: IS_LIVE,

  async execute(ctx: ProviderContext): Promise<ProviderResult> {
    const payload = buildPayload(ctx);

    if (IS_LIVE) {
      // TODO: real Razorpay API call with RAZORPAY_KEY_ID/SECRET
      // const response = await razorpay.paymentLinks.create(payload);
      // return { outcome: "SUCCEEDED", rzpResponseRef: response.id };
      throw new Error("LIVE mode not implemented; set REAL_EXECUTION_MODE=dry-run");
    }

    // DRY-RUN: log the payload, return mock outcome
    console.log(`[RAZORPAY DRY-RUN] ${ctx.actionId} for ${ctx.proposalId}:`);
    console.log(JSON.stringify(payload, null, 2));

    return {
      outcome: mockOutcome(ctx.actionId),
      dryRunPayload: payload,
    };
  },
};