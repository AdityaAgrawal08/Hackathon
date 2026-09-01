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
  amountPaise: number;
  merchantName: string;
  instrumentDescription: string; // e.g. "HDFC Bank ending in 4120"
  recoveryUrl: string;
  method?: "card" | "upi" | "netbanking" | "wallet";
  last4?: string; // Last 4 digits of card
  network?: string; // e.g. "Visa", "Mastercard", "RuPay"
  vpa?: string; // UPI VPA
  bank?: string; // Bank name
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
        `Hi ${ctx.customerName},\n\nYour payment of ${formatINR(paise(ctx.amountPaise))} for ${ctx.merchantName} could not be processed because of insufficient balance in your ${ctx.instrumentDescription}.\n\nWhat happened:\nYour account did not have enough funds to complete this transaction. No money was deducted.\n\nWhat to do:\nPlease retry with a different card or UPI, or ensure your account has sufficient balance.\n\nClick here to retry securely:\n${ctx.recoveryUrl}\n\nIf you have already paid, please ignore this message.\n\nBest regards,\nARBITER Recovery Team`,
      hi: (ctx) =>
        `Namaste ${ctx.customerName},\n\n${ctx.merchantName} ke liye ${formatINR(paise(ctx.amountPaise))} ka payment aapke ${ctx.instrumentDescription} mein balance kam hone ki wajah se process nahi ho paya.\n\nKya hua:\nAapke account mein is transaction ke liye paise kam the. Koi paisa nahi kata hai.\n\nKya karein:\nKripya kisi aur card ya UPI se retry karein, ya apne account mein paise daalein.\n\nYahan click karke abhi retry karein:\n${ctx.recoveryUrl}\n\nAgar aapne pehle se payment kar di hai, toh kripya is sandesh ko ignore karein.\n\nDhanyawad,\nARBITER Recovery Team`,
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
        `Hi ${ctx.customerName},\n\nYour payment method for ${ctx.merchantName} (${formatINR(paise(ctx.amountPaise))}) has expired or been revoked.\n\nWhat happened:\nYour ${ctx.instrumentDescription} is no longer valid for payments. This could be because the card expired, the UPI mandate was cancelled, or the saved method was removed.\n\nWhat to do:\nPlease update your payment method or set up a new one to avoid service interruption.\n\nClick here to update your payment method:\n${ctx.recoveryUrl}\n\nIf you have already updated your details, please ignore this message.\n\nBest regards,\nARBITER Recovery Team`,
      hi: (ctx) =>
        `Namaste ${ctx.customerName},\n\n${ctx.merchantName} ke liye aapka payment method (${formatINR(paise(ctx.amountPaise))}) expire ya revoke ho chuka hai.\n\nKya hua:\nAapka ${ctx.instrumentDescription} ab payments ke liye valid nahi hai. Card expire hone, UPI mandate cancel hone, ya saved method delete hone ki wajah se ho sakta hai.\n\nKya karein:\nKripya apna payment method update karein ya naya set karein taaki service mein koi rukawat na aaye.\n\nYahan click karke apna payment method update karein:\n${ctx.recoveryUrl}\n\nAgar aapne pehle se details update kar di hain, toh kripya is sandesh ko ignore karein.\n\nDhanyawad,\nARBITER Recovery Team`,
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
        `Hi ${ctx.customerName},\n\nYour payment of ${formatINR(paise(ctx.amountPaise))} for ${ctx.merchantName} could not be completed due to a temporary bank server issue.\n\nWhat happened:\n${ctx.instrumentDescription} experienced a temporary network delay. This is not an issue with your account. No money has been deducted from your bank.\n\nWhat we are doing:\nWe are actively working to resolve the bank connectivity issue. You do not need to take any action right now.\n\nWhat to do:\nWe will notify you via email and SMS as soon as the issue is resolved. If you prefer not to wait, you can pay immediately using a different bank or UPI:\n\nClick here to pay now via alternate method:\n${ctx.recoveryUrl}\n\nBest regards,\nARBITER Recovery Team`,
      hi: (ctx) =>
        `Namaste ${ctx.customerName},\n\n${ctx.merchantName} ke liye ${formatINR(paise(ctx.amountPaise))} ka payment temporary bank server issue ki wajah se process nahi ho paya.\n\nKya hua:\n${ctx.instrumentDescription} mein temporary network delay aaya. Yeh aapke account ki galti nahi hai. Aapke bank se koi paisa nahi kata hai.\n\nHum kya kar rahe hain:\nHum bank connectivity issue ko actively resolve kar rahe hain. Aapko abhi kuch karne ki zaroorat nahi hai.\n\nKya karein:\nJab issue resolve hoga hum aapko email aur SMS se notify karenge. Agar aap wait nahi karna chahte toh kisi aur bank ya UPI se turant payment kar sakte hain:\n\nYahan click karke abhi alternate method se pay karein:\n${ctx.recoveryUrl}\n\nDhanyawad,\nARBITER Recovery Team`,
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
        `Hi ${ctx.customerName},\n\nYour payment of ${formatINR(paise(ctx.amountPaise))} for ${ctx.merchantName} could not be completed.\n\nWhat happened:\nYour payment could not be processed. This may be due to a temporary issue with your bank or payment method. No money has been deducted from your account.\n\nWhat to do:\nPlease try again using a different payment method, or retry after a few minutes. If the problem persists, contact our support team.\n\nClick here to retry securely:\n${ctx.recoveryUrl}\n\nIf you have already paid, please ignore this message.\n\nBest regards,\nARBITER Recovery Team`,
      hi: (ctx) =>
        `Namaste ${ctx.customerName},\n\n${ctx.merchantName} ke liye ${formatINR(paise(ctx.amountPaise))} ka payment process nahi ho paya.\n\nKya hua:\nAapka payment process nahi ho paya. Yeh aapke bank ya payment method ke temporary issue ki wajah se ho sakta hai. Aapke account se koi paisa nahi kata hai.\n\nKya karein:\nKripya kisi aur payment method se dobara try karein, ya kuch der baad retry karein. Agar problem bani rahe toh humari support team se sampark karein.\n\nYahan click karke dobara try karein:\n${ctx.recoveryUrl}\n\nAgar aapne pehle se payment kar di hai, toh kripya is sandesh ko ignore karein.\n\nDhanyawad,\nARBITER Recovery Team`,
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
