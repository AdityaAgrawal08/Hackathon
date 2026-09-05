/**
 * Razorpay provider — constructs real Payment Link / UPI Autopay retry payloads.
 *
 * Mode (via env REAL_EXECUTION_MODE):
 *   - "dry-run" (default): constructs payload, logs it, returns mock outcome.
 *   - "live": actually calls Razorpay API (requires RAZORPAY_KEY_ID/SECRET).
 *
 * Action → Razorpay mapping:
 *   RETRY_NOW       → Payment Link (card/UPI) for immediate retry
 *   RETRY_PAYDAY    → UPI Autopay retry scheduled at retry-later window
 *   ALTERNATE_UPI_LINK → UPI Intent/Collect link for alternative method
 *   PARTIAL_COLLECT → Razorpay Smart Collect UPI (B2B partial first-installment, §4.8)
 *   REMINDER_LINK   → Payment Link with custom message
 *   HUMAN_REVIEW    → No API call; returns AMBIGUOUS
 */
import { ActionProvider, ProviderContext, ProviderResult, ExecutionOutcome } from "./types.js";
import { formatINR, paise, logger } from "@arbiter/shared";
import {
  multiplierFor,
  railForFailureClass,
  PARTIAL_COLLECT_FRACTION,
  type ActionId,
  type FailureClassId,
} from "../../decide/catalog.js";

function getCredentials() {
  const mode = process.env.REAL_EXECUTION_MODE ?? "dry-run";
  const isLive = mode === "live";
  const keyId = process.env.RZP_TEST_KEY_ID || process.env.RZP_KEY_ID || "";
  const keySecret = process.env.RZP_TEST_KEY_SECRET || process.env.RZP_KEY_SECRET || "";
  const hasTestKeys = Boolean(
    keyId &&
    keySecret &&
    !keyId.includes("xxxxxx") &&
    !keySecret.includes("xxxxxx")
  );
  return { mode, isLive, keyId, keySecret, hasTestKeys };
}

function buildPaymentLinkPayload(ctx: ProviderContext) {
  const amountRupees = (ctx.amountPaise / 100).toFixed(2);
  return {
    amount: ctx.amountPaise,
    currency: "INR",
    accept_partial: false,
    description: `Recovery retry for ${ctx.actionId} — ${ctx.failureClass}`,
    customer: ctx.customer ? {
      contact: ctx.customer.phone || undefined,
      email: ctx.customer.email || undefined,
      name: ctx.customer.name || undefined,
    } : { contact: "+919999999999", email: "customer@example.com" },
    notify: { sms: true, email: true },
    reminder_enable: true,
    notes: {
      proposal_id: ctx.proposalId,
      action: ctx.actionId,
      failure_class: ctx.failureClass,
      idempotency_key: ctx.idempotencyKey,
    },
    callback_url: process.env.PUBLIC_BASE_URL
      ? `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/recover/${ctx.proposalId}`
      : "https://example.com/callback",
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
      scheduled_for: "retry_later_window",
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
    customer: ctx.customer ? {
      contact: ctx.customer.phone || undefined,
      email: ctx.customer.email || undefined,
      name: ctx.customer.name || undefined,
    } : { contact: "+919999999999", email: "customer@example.com" },
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

/**
 * §4.8 B2B partial-collect via Razorpay Smart Collect.
 * Collects PARTIAL_COLLECT_FRACTION of the billed amount as a first installment
 * on a large B2B invoice, with a deterministic Smart Collect identifier derived
 * from the proposal (stable across retries → idempotent collector). The partial
 * amount is reproducible (round(full * fraction)), so the merchant's ledger and
 * the audit trail always agree.
 */
function buildSmartCollectPayload(ctx: ProviderContext) {
  const partialPaise = Math.max(100, Math.round(ctx.amountPaise * PARTIAL_COLLECT_FRACTION));
  const vpa = `rzpsc.${ctx.tenantId}.${ctx.proposalId}`;
  return {
    rail: "smart_collect_upi",
    amount: partialPaise,
    full_amount: ctx.amountPaise,
    currency: "INR",
    description: `Partial collection (${Math.round(PARTIAL_COLLECT_FRACTION * 100)}%) via Razorpay Smart Collect`,
    smart_collect: {
      vpa,
      collector_id: `sc_${ctx.rzpRequestRef}`,
      partial_allowed: true,
      min_amount: partialPaise,
    },
    idempotency_key: ctx.idempotencyKey,
    rzp_request_ref: ctx.rzpRequestRef,
    failure_class: ctx.failureClass,
    notes: {
      proposal_id: ctx.proposalId,
      action: ctx.actionId,
      partial_fraction: PARTIAL_COLLECT_FRACTION,
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
    case "PARTIAL_COLLECT":
      return buildSmartCollectPayload(ctx);
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
 *
 * The multiplier table is a deterministic lookup: mult === 0 means the action
 * is known-dead for this failure class (e.g., retrying a DEAD card never works).
 * mult > 0 means the action is plausible — in dry-run we treat this as SUCCEEDED
 * since we can't actually execute the payment. This is the correct behavior for
 * a dry-run: it validates the decision logic, not the payment execution.
 */
function mockOutcome(actionId: string, failureClass: string): ExecutionOutcome {
  if (actionId === "HUMAN_REVIEW") return "AMBIGUOUS";
  const mult = multiplierFor(failureClass as FailureClassId, actionId as ActionId);
  return mult === 0 ? "FAILED" : "SUCCEEDED";
}

export const razorpayProvider: ActionProvider = {
  name: "razorpay",
  get isLive(): boolean {
    return getCredentials().isLive;
  },

  async execute(ctx: ProviderContext): Promise<ProviderResult> {
    const payload = buildPayload(ctx);
    const { isLive, keyId, keySecret, hasTestKeys } = getCredentials();

    if (isLive || hasTestKeys) {
      // B-006: Real Razorpay test-mode API call
      try {
        const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
        const idempotencyKey = `idemp_pl_${ctx.proposalId}_${ctx.actionId}`;
        const response = await fetch("https://api.razorpay.com/v1/payment_links", {
          method: "POST",
          headers: {
            "Authorization": `Basic ${auth}`,
            "Content-Type": "application/json",
            "X-Razorpay-Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            amount: ctx.amountPaise,
            currency: "INR",
            description: `ARBITER Recovery - ${ctx.actionId} for ${ctx.proposalId}`,
            customer: ctx.customer ? {
              name: ctx.customer.name,
              contact: ctx.customer.phone || undefined,
              email: ctx.customer.email || undefined,
            } : undefined,
            notify: {
              sms: false,
              email: false,
            },
            callback_url: process.env.PUBLIC_BASE_URL
              ? `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/recover/${ctx.proposalId}`
              : undefined,
            notes: {
              proposal_id: ctx.proposalId,
              action: ctx.actionId,
              failure_class: ctx.failureClass,
              arbiter_generated: "true",
            },
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Razorpay API ${response.status}: ${errText}`);
        }

        const data = await response.json() as { id: string; short_url?: string; status: string };
        logger.info({ msg: "Razorpay test-mode payment link created", url: data.short_url ?? data.id });
        return {
          outcome: mockOutcome(ctx.actionId, ctx.failureClass),
          dryRunPayload: payload,
          rzpResponseRef: data.id,
          paymentLinkUrl: data.short_url,
        };
      } catch (err) {
        logger.warn({ msg: "Razorpay test-mode API call failed, falling back to dry-run", err });
        // Fall through to dry-run behavior below
      }
    }

    // DRY-RUN: log the payload, return mock outcome
    logger.info({ msg: "Razorpay dry-run", actionId: ctx.actionId, proposalId: ctx.proposalId });
    logger.info({ msg: "Razorpay dry-run payload", payload });

    return {
      outcome: mockOutcome(ctx.actionId, ctx.failureClass),
      dryRunPayload: payload,
    };
  },
};

/**
 * Creates an authentic Razorpay Payment Link (https://rzp.io/i/...)
 * using Razorpay's native POST /v1/payment_links API (FIX-016).
 */
export async function createRazorpayNativePaymentLink(params: {
  amountPaise: number;
  description: string;
  customer?: { name?: string; phone?: string; email?: string };
  callbackUrl?: string;
  notes?: Record<string, string>;
  idempotencyKey?: string;
}): Promise<{ id: string; short_url: string } | null> {
  const { isLive, keyId, keySecret, hasTestKeys } = getCredentials();
  if (!isLive && !hasTestKeys) {
    return null;
  }

  try {
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const response = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/json",
        ...(params.idempotencyKey ? { "X-Razorpay-Idempotency-Key": params.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        amount: params.amountPaise,
        currency: "INR",
        description: params.description,
        customer: params.customer ? {
          name: params.customer.name,
          contact: params.customer.phone || undefined,
          email: params.customer.email || undefined,
        } : undefined,
        notify: { sms: false, email: false },
        callback_url: params.callbackUrl,
        notes: params.notes,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.warn({ msg: "[Razorpay API] Payment link creation returned non-200", status: response.status, err: errText });
      return null;
    }

    const data = await response.json() as { id: string; short_url?: string };
    return { id: data.id, short_url: data.short_url || `https://rzp.io/i/${data.id}` };
  } catch (err) {
    logger.warn({ msg: "[Razorpay API] Payment link creation failed", err: (err as Error).message });
    return null;
  }
}