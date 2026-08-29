/**
 * Pre-audited compliance templates for customer-facing outreach (Task 1.4).
 *
 * Implements strict TRAI DLT & Meta Business API standards.
 * All personalization happens LOCALLY using deterministic token replacement.
 * ZERO customer PII is sent to external LLMs.
 */
import { formatINR, paise } from "@arbiter/shared";
import type { FailureClassId } from "../decide/catalog.js";

export type OutreachChannel = "WHATSAPP" | "SMS" | "VOICE_IVR" | "EMAIL";
export type Language = "EN" | "HI";

export interface MessageTokenContext {
  customerName: string;
  amountPaise: number;
  merchantName: string;
  instrumentDescription: string; // e.g. "HDFC Bank ending in 4120"
  recoveryUrl: string;
}

export interface RenderedMessage {
  channel: OutreachChannel;
  templateId: string;
  language: Language;
  content: string;
  recoveryUrl: string;
  dltRegistered: boolean;
}

interface TemplateDefinition {
  templateId: string;
  dltRegistered: boolean;
  en: (ctx: MessageTokenContext) => string;
  hi: (ctx: MessageTokenContext) => string;
}

const TEMPLATES_BY_CLASS: Record<FailureClassId, Record<OutreachChannel, TemplateDefinition | null>> = {
  SOFT_RETRYABLE: {
    WHATSAPP: {
      templateId: "arbiter_rec_whatsapp_insufficient_v1",
      dltRegistered: true,
      en: (ctx) =>
        `Hi ${ctx.customerName}, your subscription payment of ${formatINR(paise(ctx.amountPaise))} for ${ctx.merchantName} couldn't go through due to low balance in your ${ctx.instrumentDescription}. Would you like to complete it using an alternate UPI ID or card? Tap here: ${ctx.recoveryUrl}`,
      hi: (ctx) =>
        `Namaste ${ctx.customerName}, aapke ${ctx.instrumentDescription} mein balance kam hone ki wajah se ${ctx.merchantName} ka ${formatINR(paise(ctx.amountPaise))} ka payment pura nahi ho paya. Kripya is link se kisi dusre UPI app ya card se payment karein: ${ctx.recoveryUrl}`,
    },
    SMS: {
      templateId: "1407168923450011",
      dltRegistered: true,
      en: (ctx) =>
        `Your payment of ${formatINR(paise(ctx.amountPaise))} for ${ctx.merchantName} failed due to low balance (${ctx.instrumentDescription}). Complete now: ${ctx.recoveryUrl} - ARBITER`,
      hi: (ctx) =>
        `Aapka ${ctx.merchantName} ka ${formatINR(paise(ctx.amountPaise))} payment low balance ke karan fail hua. Abhi complete karein: ${ctx.recoveryUrl} - ARBITER`,
    },
    VOICE_IVR: {
      templateId: "ivr_script_insufficient_hi_v1",
      dltRegistered: false,
      en: (ctx) =>
        `Hello ${ctx.customerName}, this is a call from ${ctx.merchantName}. Your payment of ${formatINR(paise(ctx.amountPaise))} could not be completed. Press 1 to receive a 1-click payment link on your phone.`,
      hi: (ctx) =>
        `Namaste ${ctx.customerName}! Yeh call ${ctx.merchantName} ki taraf se hai. Aapke account mein balance kam hone ki wajah se ${formatINR(paise(ctx.amountPaise))} ka payment complete nahi ho paya. WhatsApp par 1-click payment link paane ke liye 1 dabayein.`,
    },
    EMAIL: {
      templateId: "email_insufficient_v1",
      dltRegistered: false,
      en: (ctx) =>
        `Hi ${ctx.customerName},\n\nWe couldn't process your payment of ${formatINR(paise(ctx.amountPaise))} for ${ctx.merchantName} on ${ctx.instrumentDescription} due to insufficient balance.\n\nClick here to securely retry with an alternate card or UPI: ${ctx.recoveryUrl}\n\nBest regards,\n${ctx.merchantName}`,
      hi: (ctx) =>
        `Namaste ${ctx.customerName},\n\nLow balance ki wajah se ${ctx.merchantName} ka ${formatINR(paise(ctx.amountPaise))} payment process nahi ho paya.\n\nNaye payment method se retry karne ke liye click karein: ${ctx.recoveryUrl}\n\nDhanyawad,\n${ctx.merchantName}`,
    },
  },
  HARD_METHOD_DEAD: {
    WHATSAPP: {
      templateId: "arbiter_rec_whatsapp_card_expired_v1",
      dltRegistered: true,
      en: (ctx) =>
        `Hi ${ctx.customerName}, your payment method (${ctx.instrumentDescription}) for ${ctx.merchantName} has expired or been revoked. To avoid service disruption, please update your details or switch to UPI AutoPay here: ${ctx.recoveryUrl}`,
      hi: (ctx) =>
        `Namaste ${ctx.customerName}, ${ctx.merchantName} ke liye aapka payment method (${ctx.instrumentDescription}) expire ho gaya hai. Service bina kisi rukawat chalte rehne ke liye kripya naya method update karein: ${ctx.recoveryUrl}`,
    },
    SMS: {
      templateId: "1407168923450012",
      dltRegistered: true,
      en: (ctx) =>
        `Your card/mandate for ${ctx.merchantName} (${formatINR(paise(ctx.amountPaise))}) has expired. Update your payment method to avoid service interruption: ${ctx.recoveryUrl} - ARBITER`,
      hi: (ctx) =>
        `${ctx.merchantName} ke liye aapka card expire ho gaya hai (${formatINR(paise(ctx.amountPaise))}). Service continue rakhne ke liye update karein: ${ctx.recoveryUrl} - ARBITER`,
    },
    VOICE_IVR: {
      templateId: "ivr_script_expired_hi_v1",
      dltRegistered: false,
      en: (ctx) =>
        `Hello ${ctx.customerName}, your payment card for ${ctx.merchantName} has expired. Press 1 to get a secure update link on your phone.`,
      hi: (ctx) =>
        `Namaste ${ctx.customerName}! ${ctx.merchantName} ke liye aapka card expire ho gaya hai. SMS par secure update link paane ke liye 1 dabayein.`,
    },
    EMAIL: {
      templateId: "email_card_expired_v1",
      dltRegistered: false,
      en: (ctx) =>
        `Hi ${ctx.customerName},\n\nYour payment method (${ctx.instrumentDescription}) for ${ctx.merchantName} has expired.\n\nPlease update your payment details or set up UPI AutoPay here: ${ctx.recoveryUrl}\n\nBest regards,\n${ctx.merchantName}`,
      hi: (ctx) =>
        `Namaste ${ctx.customerName},\n\n${ctx.merchantName} ke liye aapka card (${ctx.instrumentDescription}) expire ho chuka hai.\n\nNaya payment method update karne ke liye click karein: ${ctx.recoveryUrl}`,
    },
  },
  NETWORK_TIMEOUT: {
    WHATSAPP: {
      templateId: "arbiter_rec_whatsapp_bank_down_v1",
      dltRegistered: true,
      en: (ctx) =>
        `Hi ${ctx.customerName}, your bank (${ctx.instrumentDescription}) is currently experiencing technical delays. No money was deducted for ${ctx.merchantName}. We will retry automatically, or you can pay now via another UPI app: ${ctx.recoveryUrl}`,
      hi: (ctx) =>
        `Namaste ${ctx.customerName}, aapka bank (${ctx.instrumentDescription}) temporary network issue face kar raha hai. ${ctx.merchantName} ke liye koi paisa nahi kata hai. Aap chahein toh dusre bank UPI se turant payment kar sakte hain: ${ctx.recoveryUrl}`,
    },
    SMS: {
      templateId: "1407168923450013",
      dltRegistered: true,
      en: (ctx) =>
        `Bank network delay detected on your payment to ${ctx.merchantName}. Retry instantly via alternate UPI: ${ctx.recoveryUrl} - ARBITER`,
      hi: (ctx) =>
        `Bank network issue detected. ${ctx.merchantName} ka payment alternate UPI se complete karein: ${ctx.recoveryUrl} - ARBITER`,
    },
    VOICE_IVR: null,
    EMAIL: {
      templateId: "email_bank_down_v1",
      dltRegistered: false,
      en: (ctx) =>
        `Hi ${ctx.customerName},\n\nYour bank (${ctx.instrumentDescription}) had a temporary network glitch during your payment of ${formatINR(paise(ctx.amountPaise))} for ${ctx.merchantName}.\n\nYou can pay securely with any alternate bank UPI or card here: ${ctx.recoveryUrl}`,
      hi: (ctx) =>
        `Namaste ${ctx.customerName},\n\nBank network issue ki wajah se payment complete nahi ho paya.\n\nDusre payment method se try karne ke liye click karein: ${ctx.recoveryUrl}`,
    },
  },
  RISK_FLAGGED: {
    WHATSAPP: null,
    SMS: null,
    VOICE_IVR: null,
    EMAIL: null,
  },
  UNKNOWN: {
    WHATSAPP: null,
    SMS: null,
    VOICE_IVR: null,
    EMAIL: null,
  },
};

/**
 * Render a compliant, localized recovery message locally.
 * Returns null for RISK_FLAGGED or UNKNOWN classes (prohibited from auto-outreach).
 */
export function renderComplianceMessage(
  failureClass: FailureClassId,
  channel: OutreachChannel,
  language: Language,
  context: MessageTokenContext,
): RenderedMessage | null {
  const def = TEMPLATES_BY_CLASS[failureClass]?.[channel];
  if (!def) return null;

  const content = language === "HI" ? def.hi(context) : def.en(context);

  return {
    channel,
    templateId: def.templateId,
    language,
    content,
    recoveryUrl: context.recoveryUrl,
    dltRegistered: def.dltRegistered,
  };
}
