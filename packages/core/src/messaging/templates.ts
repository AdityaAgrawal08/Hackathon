/**
 * Pre-audited compliance templates for customer-facing outreach (Task 1.4).
 *
 * Implements strict TRAI DLT & Meta Business API standards.
 * All personalization happens LOCALLY using deterministic token replacement.
 * ZERO customer PII is sent to external LLMs.
 */
import { formatINR, paise } from "@arbiter/shared";
import type { FailureClassId } from "../decide/catalog.js";
import type { OutreachChannel } from "./types.js";

export type Language = "EN" | "HI";


export interface MessageTokenContext {
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  amountPaise: number;
  merchantName: string;
  instrumentDescription: string; // e.g. "HDFC Bank ending in 4120"
  recoveryUrl: string;
  customerMessage?: string; // GROQ-polished, transaction-specific (no PII sent to GROQ)
  vendorMessage?: string;   // from error catalog — for vendor
  method?: "card" | "upi" | "netbanking" | "wallet";
  last4?: string;
  network?: string;
  vpa?: string;
  bank?: string;
}

function customerDetailsBlock(ctx: MessageTokenContext): string {
  const lines: string[] = [];
  lines.push(`Customer: ${ctx.customerName}`);
  if (ctx.customerEmail) lines.push(`Email: ${ctx.customerEmail}`);
  if (ctx.customerPhone) lines.push(`Phone: ${ctx.customerPhone}`);
  lines.push(`Amount: ${formatINR(paise(ctx.amountPaise))}`);
  if (ctx.instrumentDescription) lines.push(`Payment: ${ctx.instrumentDescription}`);
  return lines.join("\n");
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

const TEMPLATES_BY_CLASS: Record<FailureClassId, Partial<Record<OutreachChannel, TemplateDefinition | null>>> = {
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
        `ARBITER: Your ${formatINR(paise(ctx.amountPaise))} payment failed due to insufficient funds. Retry now: ${ctx.recoveryUrl}`,
      hi: (ctx) =>
        `ARBITER: ${formatINR(paise(ctx.amountPaise))} ka payment balance kam hone se fail hua. Abhi retry karein: ${ctx.recoveryUrl}`,
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
        `Hi ${ctx.customerName},\n\nYour payment of ${formatINR(paise(ctx.amountPaise))} for ${ctx.merchantName} could not be completed.\n\n${customerDetailsBlock(ctx)}\n\nReason:\n${ctx.customerMessage || 'Your account did not have enough funds to complete this transaction. No money was deducted.'}\n\nWhat to do:\nPlease retry with a different card or UPI, or ensure your account has sufficient balance.\n\nClick here to retry securely (unique to this transaction):\n${ctx.recoveryUrl}\n\nIf you have already paid, clicking the link will show your payment confirmation.\n\nBest regards,\nARBITER Recovery Team`,
      hi: (ctx) =>
        `Namaste ${ctx.customerName},\n\n${ctx.merchantName} ke liye ${formatINR(paise(ctx.amountPaise))} ka payment process nahi ho paya.\n\n${customerDetailsBlock(ctx)}\n\nKaran:\n${ctx.customerMessage || 'Aapke account mein is transaction ke liye paise kam the. Koi paisa nahi kata hai.'}\n\nKya karein:\nKripya kisi aur card ya UPI se retry karein, ya apne account mein paise daalein.\n\nYahan click karke abhi retry karein (sirf is transaction ke liye):\n${ctx.recoveryUrl}\n\nAgar aapne pehle se payment kar di hai, toh link par click karne se aapko confirmation dikhega.\n\nDhanyawad,\nARBITER Recovery Team`,
    },
  },
  HARD_METHOD_DEAD: {
    WHATSAPP: {
      templateId: "arbiter_rec_whatsapp_card_expired_v1",
      dltRegistered: true,
      en: (ctx) =>
        `Hi ${ctx.customerName}, your payment method (${ctx.instrumentDescription}) for ${ctx.merchantName} (${formatINR(paise(ctx.amountPaise))}) has expired or been revoked. To avoid service disruption, please update your details or switch to UPI AutoPay here: ${ctx.recoveryUrl}`,
      hi: (ctx) =>
        `Namaste ${ctx.customerName}, ${ctx.merchantName} ke liye aapka payment method (${ctx.instrumentDescription} - ${formatINR(paise(ctx.amountPaise))}) expire ho gaya hai. Service bina kisi rukawat chalte rehne ke liye kripya naya method update karein: ${ctx.recoveryUrl}`,
    },

    SMS: {
      templateId: "1407168923450012",
      dltRegistered: true,
      en: (ctx) =>
        `ARBITER: Your card/mandate for ${formatINR(paise(ctx.amountPaise))} has expired or been revoked. Update now: ${ctx.recoveryUrl}`,
      hi: (ctx) =>
        `ARBITER: ${formatINR(paise(ctx.amountPaise))} ka payment method expire ho gaya hai. Abhi update karein: ${ctx.recoveryUrl}`,
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
        `Hi ${ctx.customerName},\n\nYour payment of ${formatINR(paise(ctx.amountPaise))} for ${ctx.merchantName} could not be completed.\n\n${customerDetailsBlock(ctx)}\n\nReason:\n${ctx.customerMessage || 'Your payment method is no longer valid for payments.'}\n\nWhat to do:\nPlease update your payment method or set up a new one to avoid service interruption.\n\nClick here to update your payment method (unique to this transaction):\n${ctx.recoveryUrl}\n\nIf you have already updated your details, clicking the link will show confirmation.\n\nBest regards,\nARBITER Recovery Team`,
      hi: (ctx) =>
        `Namaste ${ctx.customerName},\n\n${ctx.merchantName} ke liye ${formatINR(paise(ctx.amountPaise))} ka payment process nahi ho paya.\n\n${customerDetailsBlock(ctx)}\n\nKaran:\n${ctx.customerMessage || 'Aapka payment method ab payments ke liye valid nahi hai.'}\n\nKya karein:\nKripya apna payment method update karein ya naya set karein taaki service mein koi rukawat na aaye.\n\nYahan click karke apna payment method update karein (sirf is transaction ke liye):\n${ctx.recoveryUrl}\n\nAgar aapne pehle se details update kar di hain, toh link par confirmation dikhega.\n\nDhanyawad,\nARBITER Recovery Team`,
    },
  },
  // ──────────────────────────────────────────────────────────────────
  // NETWORK_TIMEOUT: Bank downtime, gateway timeout, network error
  // User action needed: WAIT — we are resolving, will notify when fixed
  // ──────────────────────────────────────────────────────────────────
  NETWORK_TIMEOUT: {
    WHATSAPP: {
      templateId: "arbiter_rec_whatsapp_bank_down_v1",
      dltRegistered: true,
      en: (ctx) =>
        `Hi ${ctx.customerName}, your bank (${ctx.instrumentDescription}) is currently experiencing technical delays. No money was deducted for ${ctx.merchantName}. We are working to resolve this and will notify you once it's fixed. You can also retry via another UPI: ${ctx.recoveryUrl}`,
      hi: (ctx) =>
        `Namaste ${ctx.customerName}, aapka bank (${ctx.instrumentDescription}) temporary technical issue face kar raha hai. ${ctx.merchantName} ke liye koi paisa nahi kata hai. Hum isse resolve kar rahe hain aur aapko notify karenge. Aap chahein toh dusre UPI se try kar sakte hain: ${ctx.recoveryUrl}`,
    },
    SMS: {
      templateId: "1407168923450013",
      dltRegistered: true,
      en: (ctx) =>
        `ARBITER: Bank server issue for your ${formatINR(paise(ctx.amountPaise))} payment. No money deducted. We are resolving this and will notify you. Retry: ${ctx.recoveryUrl}`,
      hi: (ctx) =>
        `ARBITER: ${formatINR(paise(ctx.amountPaise))} payment mein bank server issue. Koi paisa nahi kata. Hum resolve kar rahe hain, aapko notify karenge. Retry: ${ctx.recoveryUrl}`,
    },
    VOICE_IVR: null,
    EMAIL: {
      templateId: "email_bank_down_v1",
      dltRegistered: false,
      en: (ctx) =>
        `Hi ${ctx.customerName},\n\nYour payment of ${formatINR(paise(ctx.amountPaise))} for ${ctx.merchantName} could not be completed.\n\n${customerDetailsBlock(ctx)}\n\nReason:\n${ctx.customerMessage || 'Your bank or payment provider experienced a temporary issue. No money has been deducted from your account.'}\n\nWhat to do:\nPlease try again in a few minutes, or use a different payment method.\n\nClick here to retry (unique to this transaction):\n${ctx.recoveryUrl}\n\nIf you have already paid, clicking the link will show confirmation.\n\nBest regards,\nARBITER Recovery Team`,
      hi: (ctx) =>
        `Namaste ${ctx.customerName},\n\n${ctx.merchantName} ke liye ${formatINR(paise(ctx.amountPaise))} ka payment process nahi ho paya.\n\n${customerDetailsBlock(ctx)}\n\nKaran:\n${ctx.customerMessage || 'Aapke bank ya payment provider mein temporary issue aaya. Aapke account se koi paisa nahi kata hai.'}\n\nKya karein:\nKuch der baad dobara try karein, ya kisi aur payment method ka upyog karein.\n\nYahan click karke dobara try karein (sirf is transaction ke liye):\n${ctx.recoveryUrl}\n\nAgar aapne pehle se payment kar di hai, toh link par confirmation dikhega.\n\nDhanyawad,\nARBITER Recovery Team`,
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
    EMAIL: {
      templateId: "email_unknown_v1",
      dltRegistered: false,
      en: (ctx) =>
        `Hi ${ctx.customerName},\n\nYour payment of ${formatINR(paise(ctx.amountPaise))} for ${ctx.merchantName} could not be completed.\n\n${customerDetailsBlock(ctx)}\n\nReason:\n${ctx.customerMessage || 'Your payment could not be processed. This may be a temporary issue. No money has been deducted from your account.'}\n\nWhat to do:\nPlease try again using a different payment method, or retry after a few minutes.\n\nClick here to retry securely (unique to this transaction):\n${ctx.recoveryUrl}\n\nIf you have already paid, clicking the link will show your payment confirmation.\n\nBest regards,\nARBITER Recovery Team`,
      hi: (ctx) =>
        `Namaste ${ctx.customerName},\n\n${ctx.merchantName} ke liye ${formatINR(paise(ctx.amountPaise))} ka payment process nahi ho paya.\n\n${customerDetailsBlock(ctx)}\n\nKaran:\n${ctx.customerMessage || 'Aapka payment process nahi ho paya. Yeh temporary issue ho sakta hai. Aapke account se koi paisa nahi kata hai.'}\n\nKya karein:\nKripya kisi aur payment method se dobara try karein, ya kuch der baad retry karein.\n\nYahan click karke dobara try karein (sirf is transaction ke liye):\n${ctx.recoveryUrl}\n\nAgar aapne pehle se payment kar di hai, toh link par aapko confirmation dikhega.\n\nDhanyawad,\nARBITER Recovery Team`,
    },
  },
};

/**
 * Render a compliant, localized recovery message locally.
 * Returns null for RISK_FLAGGED class (prohibited from auto-outreach).
 */
export function renderComplianceMessage(
  failureClass: FailureClassId,
  channel: OutreachChannel,
  language: Language,
  context: MessageTokenContext,
): RenderedMessage | null {
  const targetChannel: OutreachChannel = channel === "VOICE" ? "VOICE_IVR" : channel;
  const def = TEMPLATES_BY_CLASS[failureClass]?.[targetChannel];
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
