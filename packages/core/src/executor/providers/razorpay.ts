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
import { formatINR, paise } from "@arbiter/shared";
import {
  multiplierFor,
  railForFailureClass,
  type ActionId,
  type FailureClassId,
} from "../../decide/catalog.js";

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

function buildCrossPspPayload(ctx: ProviderContext) {
  const rail = railForFailureClass(ctx.failureClass as FailureClassId);
  return {
    recovery_rail: rail,
    source_psp: "razorpay",
    amount: ctx.amountPaise,
    currency: "INR",
    idempotency_key: ctx.idempotencyKey,
    rzp_request_ref: ctx.rzpRequestRef,
    failure_class: ctx.failureClass,
    optimizer_route: rail === "optimizer_secondary_psp",
    notes: {
      proposal_id: ctx.proposalId,
      action: ctx.actionId,
      switched_from: "primary_rail",
      idempotency_key: ctx.idempotencyKey,
    },
  };
}

/**
 * Gupshup / WhatsApp Business API recovery template (§4.6).
 * Hinglish template with a single {{1}} personalization slot — the failed
 * amount in INR. Deterministic, auditable, and language-localized so the
 * recovery reaches non-English customers (a real India differentiator).
 */
function buildWhatsAppPayload(ctx: ProviderContext) {
  const amountInr = formatINR(paise(ctx.amountPaise));
  return {
    channel: "whatsapp",
    provider: "gupshup",
    template: {
      name: "recovery_reminder_hinglish",
      language: "hi",
      // WhatsApp Business template variables; {{1}} is the failed amount.
      components: [{ type: "body", parameters: [{ type: "text", text: amountInr }] }],
    },
    preview: `नमस्ते, आपका ₹${ctx.amountPaise / 100} का पेमेंट फेल हुआ है। कृपया दोबारा प्रयास करें।`,
    personalization: { "1": amountInr },
    idempotency_key: ctx.idempotencyKey,
    rzp_request_ref: ctx.rzpRequestRef,
    failure_class: ctx.failureClass,
    notes: { proposal_id: ctx.proposalId, action: ctx.actionId },
  };
}

/** Regional voice recovery (§4.6) — same template model, delivered by voice. */
function buildVoicePayload(ctx: ProviderContext) {
  const amountInr = formatINR(paise(ctx.amountPaise));
  return {
    channel: "voice",
    provider: "gupshup",
    template: {
      name: "recovery_voice_hinglish",
      language: "hi",
      components: [{ type: "body", parameters: [{ type: "text", text: amountInr }] }],
    },
    personalization: { "1": amountInr },
    idempotency_key: ctx.idempotencyKey,
    rzp_request_ref: ctx.rzpRequestRef,
    failure_class: ctx.failureClass,
    notes: { proposal_id: ctx.proposalId, action: ctx.actionId },
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
    case "RECOVER_VIA_RAIL":
      return buildCrossPspPayload(ctx);
    case "RECOVER_VOICE_HI":
      return buildVoicePayload(ctx);
    case "RECOVER_WHATSAPP":
      return buildWhatsAppPayload(ctx);
    case "REMINDER_LINK":
      return buildReminderLinkPayload(ctx);
    default:
      return { notes: { proposal_id: ctx.proposalId, action: ctx.actionId } };
  }
}

/**
 * Honest dry-run outcome (bug #13): mirror the catalog multiplier so a DEAD
 * action for this class fails even in dry-run, instead of blindly succeeding.
 * HUMAN_REVIEW always needs a human (AMBIGUOUS).
 */
function mockOutcome(actionId: string, failureClass: string): ExecutionOutcome {
  if (actionId === "HUMAN_REVIEW") return "AMBIGUOUS";
  const mult = multiplierFor(failureClass as FailureClassId, actionId as ActionId);
  return mult === 0 ? "FAILED" : "SUCCEEDED";
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
      outcome: mockOutcome(ctx.actionId, ctx.failureClass),
      dryRunPayload: payload,
    };
  },
};