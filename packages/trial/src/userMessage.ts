/**
 * Personalized, safe customer-facing messages.
 *
 * CRITICAL: these messages are derived ONLY from the *simulated* failure class
 * and the safe provider error code. They never expose internal errors, stack
 * traces, database state, or gateway implementation details. This is the
 * UI-facing text the trial verifies — the system must not leak internals.
 */
import { formatINR, paise } from "@arbiter/shared";

export type TrialClientVisible = "SUCCEEDED" | "FAILED" | "UNKNOWN" | "CANCELLED" | "ALREADY_SUBMITTED" | "PROCESSING";
export type Locale = "en" | "hi";

export interface UserMessageInput {
  visible: TrialClientVisible;
  amountPaise: number;
  errorCode?: string;
  failureClass?: string;
  locale?: Locale;
}

const AMOUNT = (p: number) => formatINR(paise(p));

export function userFacingMessage(input: UserMessageInput): string {
  const amount = AMOUNT(input.amountPaise);
  const locale = input.locale ?? "en";
  const hi = locale === "hi";

  switch (input.visible) {
    case "SUCCEEDED":
      return hi
        ? `धन्यवाद! आपका ₹${amount} का भुगतान सफल रहा।`
        : `Thank you — your payment of ${amount} was received.`;
    case "CANCELLED":
      return hi
        ? `आपका भुगतान रद्द कर दिया गया है, जैसा आपने अनुरोध किया था।`
        : `Your payment was cancelled, as you requested.`;
    case "ALREADY_SUBMITTED":
    case "PROCESSING":
      return hi
        ? `आपका भुगतान पहले से प्रोसेस हो रहा है। कृपया प्रतीक्षा करें — दोहरा चार्ज से बचने के लिए रिट्राई न करें।`
        : `Your payment is already being processed. Please wait — don't retry, to avoid a double charge.`;
    case "UNKNOWN":
      // The hazardous "charged but response lost / uncertain" case.
      return hi
        ? `हम आपके बैंक से भुगतान की पुष्टि कर रहे हैं। यदि सफल हुआ तो राशि जल्द दिखेगी; असफल होने पर कोई पैसा नहीं कटा।`
        : `We're confirming your payment with your bank. If it succeeded, it'll appear shortly; if not, no money was taken.`;
    case "FAILED":
    default:
      return failedMessage(input, amount, hi);
  }
}

function failedMessage(input: UserMessageInput, amount: string, hi: boolean): string {
  switch (input.errorCode) {
    case "RZP_INSUFFICIENT_FUNDS":
      return hi
        ? `आपके खाते में पर्याप्त बैलेंस नहीं था। हम वेतन तारीख पर अपने-आप रिट्राई करेंगे — कोई कार्रवाई आवश्यक नहीं।`
        : `Your account had insufficient balance. We'll retry automatically on your salary date — no action needed.`;
    case "RZP_EXPIRED_METHOD":
      return hi
        ? `आपका सेव्ह कार्ड एक्सपायर हो गया है। कृपया नई भुगतान विधि जोड़ें।`
        : `Your saved card has expired. Please add a new payment method to continue.`;
    case "RZP_INVALID_DETAILS":
      return hi
        ? `कुछ भुगतान विवरण गलत थे। कृपया ऐप में अपडेट करें।`
        : `Some payment details were invalid. Please update them in the app.`;
    case "RZP_REJECTED":
      return hi
        ? `आपके बैंक ने चार्ज अस्वीकार कर दिया। कोई दूसरी विधि आज़माएँ।`
        : `Your bank declined this charge. You can try a different method.`;
    case "RZP_RATE_LIMITED":
      return hi
        ? `अभी बहुत अनुरोध हैं; हम जल्द ही रिट्राई करेंगे।`
        : `Too many requests right now — we'll retry shortly.`;
    default:
      return hi
        ? `भुगतान पूरा नहीं हो सका (${amount})। कृपया बाद में पुनः प्रयास करें।`
        : `We couldn't complete your payment of ${amount}. Please try again later.`;
  }
}

/** Which channel the recovery action would use (for the notification record). */
export function channelForAction(actionId: string): "SMS" | "WHATSAPP" | "VOICE" | "EMAIL" | "IN_APP" {
  switch (actionId) {
    case "RECOVER_WHATSAPP":
      return "WHATSAPP";
    case "RECOVER_VOICE_HI":
      return "VOICE";
    case "REMINDER_LINK":
      return "EMAIL";
    default:
      return "IN_APP";
  }
}
