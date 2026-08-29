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
  const code = input.errorCode ?? "";
  if (code === "RZP_INSUFFICIENT_FUNDS" || code === "LOCAL_INSUFFICIENT_FUNDS") {
    return hi
      ? `आपके खाते में पर्याप्त बैलेंस नहीं था। कृपया बैलेंस चेक करें या दूसरी भुगतान विधि चुनें।`
      : `Your account had insufficient balance. Please check your balance or try a different payment method.`;
  }
  if (code === "RZP_EXPIRED_METHOD" || code === "LOCAL_EXPIRED_METHOD") {
    return hi
      ? `आपका कार्ड या भुगतान विधि एक्सपायर हो गई है। कृपया नई विधि जोड़ें।`
      : `Your payment method has expired. Please add a valid payment method to continue.`;
  }
  if (code === "RZP_INVALID_DETAILS" || code === "LOCAL_INVALID_DETAILS") {
    return hi
      ? `कुछ भुगतान विवरण अमान्य थे। कृपया विवरण जांचें और पुनः प्रयास करें।`
      : `Some payment details were invalid. Please review your details and try again.`;
  }
  if (code === "RZP_REJECTED" || code === "LOCAL_RISK_REJECTED") {
    return hi
      ? `आपके बैंक ने इस लेनदेन को अस्वीकार कर दिया। कृपया दूसरी विधि आज़माएँ।`
      : `Your bank declined this transaction. You can try a different payment method.`;
  }
  if (code === "RZP_RATE_LIMITED" || code === "LOCAL_GATEWAY_503") {
    return hi
      ? `गेटवे पर अभी अधिक लोड है। कृपया कुछ पलों बाद पुनः प्रयास करें।`
      : `Payment services are experiencing temporary load. Please try again in a few moments.`;
  }
  if (code === "LOCAL_GATEWAY_TIMEOUT") {
    return hi
      ? `गेटवे से समय पर जवाब नहीं मिला। हम बैंक से पुष्टि कर रहे हैं।`
      : `The gateway did not respond in time. We are confirming the status with your bank.`;
  }
  if (code === "RZP_AUTH_EXPIRED") {
    return hi
      ? `भुगतान प्रमाणीकरण समय समाप्त हो गया। कृपया पुनः प्रयास करें।`
      : `Payment authorization expired. Please try again.`;
  }
  if (code === "RZP_SERVER_ERROR" || code === "LOCAL_GATEWAY_503") {
    return hi
      ? `भुगतान सेवा अभी उपलब्ध नहीं है। कृपया कुछ पलों बाद पुनः प्रयास करें।`
      : `Payment services are temporarily unavailable. Please try again in a few moments.`;
  }
  return hi
    ? `भुगतान पूरा नहीं हो सका (${amount})। कृपया बाद में पुनः प्रयास करें।`
    : `We couldn't complete your payment of ${amount}. Please try again later.`;
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
    case "RECOVER_VIA_RAIL":
      return "SMS";
    case "PARTIAL_COLLECT":
      return "IN_APP";
    default:
      return "IN_APP";
  }
}

