/**
 * Comprehensive Razorpay Error Code Catalog
 *
 * Every error code from Razorpay docs mapped to:
 * - customerMessage: Simplified text shown to the customer (NO raw codes)
 * - vendorMessage: Simplified text shown to the vendor dashboard
 * - failureClass: SOFT_RETRYABLE | HARD_METHOD_DEAD | NETWORK_TIMEOUT | RISK_FLAGGED | UNKNOWN
 * - recommendedAction: What the AI should do (retry_now, retry_later, use_different_method, contact_support, etc.)
 *
 * Sources:
 * - https://razorpay.com/docs/errors/payments/cards/
 * - https://razorpay.com/docs/errors/payments/upi/
 * - https://d6xcmfyh68wv8.cloudfront.net/docs/errors/reasons/
 */

export type FailureClass =
  | "SOFT_RETRYABLE"
  | "HARD_METHOD_DEAD"
  | "NETWORK_TIMEOUT"
  | "RISK_FLAGGED"
  | "UNKNOWN";

export type RecommendedAction =
  | "retry_now"
  | "retry_later"
  | "use_different_method"
  | "use_different_card"
  | "add_funds"
  | "check_card_details"
  | "enable_online_transactions"
  | "contact_bank"
  | "contact_support"
  | "vendor_review"
  | "no_action";

export interface ErrorCatalogEntry {
  /** Simplified message for the CUSTOMER (never raw error codes) */
  customerMessage: string;
  /** Simplified message for the VENDOR dashboard */
  vendorMessage: string;
  /** Failure classification for ML pipeline */
  failureClass: FailureClass;
  /** Recommended AI action */
  recommendedAction: RecommendedAction;
}

export const RAZORPAY_ERROR_CATALOG: Record<string, ErrorCatalogEntry> = {
  // ═══════════════════════════════════════════════════════════════════
  // CARD ERRORS
  // ═══════════════════════════════════════════════════════════════════

  insufficient_funds: {
    customerMessage: "Your account doesn't have enough funds for this transaction. Please add money to your account or use a different payment method.",
    vendorMessage: "Customer has insufficient funds in their account.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "retry_later",
  },

  card_expired: {
    customerMessage: "Your card has expired. Please use a different card or update your card details.",
    vendorMessage: "Customer's card has expired.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_card",
  },

  card_declined: {
    customerMessage: "Your bank declined this payment. Please try a different card or contact your bank for details.",
    vendorMessage: "Bank declined the card payment. No specific reason provided by the bank.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_method",
  },

  card_not_enrolled: {
    customerMessage: "Your card is not enabled for online payments. Please enable online transactions through your bank's app or net banking.",
    vendorMessage: "Card is not enrolled for online transactions.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "enable_online_transactions",
  },

  card_disabled_for_online_payments: {
    customerMessage: "Your card is not enabled for online payments. Please enable online transactions through your bank's app or net banking.",
    vendorMessage: "Card is disabled for online payments by the customer's bank.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "enable_online_transactions",
  },

  debit_instrument_inactive: {
    customerMessage: "Your card is inactive or frozen. Please contact your bank to reactivate it, or use a different card.",
    vendorMessage: "Customer's card is inactive or frozen.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "contact_bank",
  },

  debit_instrument_blocked: {
    customerMessage: "Your card has been blocked. Please contact your bank to unblock it, or use a different card.",
    vendorMessage: "Customer's card is blocked by the bank or the customer.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "contact_bank",
  },

  incorrect_cvv: {
    customerMessage: "You entered the wrong CVV. Please check the 3-digit number on the back of your card and try again.",
    vendorMessage: "Customer entered incorrect CVV.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "retry_now",
  },

  authentication_failed: {
    customerMessage: "The OTP or verification code you entered was incorrect. Please try again with the correct code.",
    vendorMessage: "Customer entered incorrect OTP or authentication details.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "retry_now",
  },

  incorrect_otp: {
    customerMessage: "The OTP you entered is incorrect. Please check your phone and enter the correct code.",
    vendorMessage: "Customer entered incorrect OTP.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "retry_now",
  },

  incorrect_pin: {
    customerMessage: "The PIN you entered is incorrect. Please try again with the correct PIN.",
    vendorMessage: "Customer entered incorrect PIN.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "retry_now",
  },

  incorrect_atm_pin: {
    customerMessage: "The ATM PIN you entered is incorrect. Please try again with the correct PIN.",
    vendorMessage: "Customer entered incorrect ATM PIN.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "retry_now",
  },

  incorrect_card_details: {
    customerMessage: "Some of your card details are incorrect. Please double-check your card number, expiry date, and CVV.",
    vendorMessage: "Customer entered incorrect card details.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "check_card_details",
  },

  incorrect_card_expiry_date: {
    customerMessage: "The expiry date on your card is incorrect. Please check and enter the correct date.",
    vendorMessage: "Customer entered incorrect card expiry date.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "check_card_details",
  },

  incorrect_cardholder_name: {
    customerMessage: "The name on the card doesn't match. Please enter the name exactly as it appears on your card.",
    vendorMessage: "Customer entered incorrect cardholder name.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "check_card_details",
  },

  card_number_invalid: {
    customerMessage: "The card number you entered is not valid. Please check and enter the correct card number.",
    vendorMessage: "Customer entered an invalid card number.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "check_card_details",
  },

  transaction_limit_exceeded: {
    customerMessage: "You've reached your card's daily transaction limit. Please try again tomorrow or use a different card.",
    vendorMessage: "Customer exceeded the daily transaction limit on their card.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "use_different_method",
  },

  transaction_daily_limit_exceeded: {
    customerMessage: "You've reached your card's daily transaction limit. Please try again tomorrow or use a different card.",
    vendorMessage: "Customer exceeded the daily transaction limit on their card.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "use_different_method",
  },

  transaction_daily_count_exceeded: {
    customerMessage: "You've made too many transactions today. Please try again tomorrow or use a different card.",
    vendorMessage: "Customer exceeded the maximum number of daily transactions.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "use_different_method",
  },

  otp_attempts_exceeded: {
    customerMessage: "You've entered the wrong OTP too many times. Your card is temporarily blocked. Please try again later or use a different card.",
    vendorMessage: "Customer exceeded OTP retry limit. Card temporarily blocked.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_card",
  },

  pin_attempts_exceeded: {
    customerMessage: "You've entered the wrong PIN too many times. Your card is temporarily blocked. Please try again later or use a different card.",
    vendorMessage: "Customer exceeded PIN retry limit. Card temporarily blocked.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_card",
  },

  card_type_invalid: {
    customerMessage: "This card type is not accepted for this transaction. Please use a different card.",
    vendorMessage: "Customer is using an unsupported card type for this transaction.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_card",
  },

  card_network_not_enabled: {
    customerMessage: "This card network is not supported. Please try a card from a different network (Visa, Mastercard, RuPay).",
    vendorMessage: "Card network is not enabled for this merchant.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_card",
  },

  // ═══════════════════════════════════════════════════════════════════
  // UPI ERRORS
  // ═══════════════════════════════════════════════════════════════════

  invalid_vpa: {
    customerMessage: "The UPI ID you entered is not valid. Please check your UPI ID and try again.",
    vendorMessage: "Customer entered an invalid or unregistered UPI ID.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "retry_now",
  },

  vpa_resolution_failed: {
    customerMessage: "We couldn't verify your UPI ID. This is a temporary issue. Please try again or use a different UPI ID.",
    vendorMessage: "UPI network failed to validate the customer's VPA. Technical error at NPCI.",
    failureClass: "NETWORK_TIMEOUT",
    recommendedAction: "retry_later",
  },

  payment_collect_request_expired: {
    customerMessage: "The UPI payment request expired. You didn't complete the payment in time. Please try again.",
    vendorMessage: "Customer didn't complete the UPI collect request within the time limit.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "retry_now",
  },

  credit_failed: {
    customerMessage: "The payment couldn't be completed from your bank account. Please check your account details or try a different bank.",
    vendorMessage: "Beneficiary bank rejected the credit. Possible account mismatch or bank issue.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "use_different_method",
  },

  upi_app_technical_error: {
    customerMessage: "There's a technical issue with your UPI app. Please try again after a few minutes, or use a different UPI app.",
    vendorMessage: "Technical error at the customer's UPI PSP (app).",
    failureClass: "NETWORK_TIMEOUT",
    recommendedAction: "retry_later",
  },

  // ═══════════════════════════════════════════════════════════════════
  // BANK / GATEWAY ERRORS (shared across methods)
  // ═══════════════════════════════════════════════════════════════════

  bank_technical_error: {
    customerMessage: "Your bank's server is currently experiencing issues. No money was deducted. Please try again in a few minutes.",
    vendorMessage: "Customer's bank is experiencing technical difficulties.",
    failureClass: "NETWORK_TIMEOUT",
    recommendedAction: "retry_later",
  },

  gateway_technical_error: {
    customerMessage: "There's a temporary issue with the payment gateway. No money was deducted. Please try again shortly.",
    vendorMessage: "Payment gateway technical error. Bank or gateway server issue.",
    failureClass: "NETWORK_TIMEOUT",
    recommendedAction: "retry_later",
  },

  payment_timed_out: {
    customerMessage: "The payment took too long and timed out. No money was deducted. Please try again.",
    vendorMessage: "Payment timed out. Customer didn't complete within the time limit.",
    failureClass: "NETWORK_TIMEOUT",
    recommendedAction: "retry_now",
  },

  payment_cancelled: {
    customerMessage: "You cancelled the payment. If this was a mistake, please try again.",
    vendorMessage: "Customer cancelled the transaction.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "retry_now",
  },

  payment_declined: {
    customerMessage: "Your bank declined this payment. Please try a different payment method or contact your bank.",
    vendorMessage: "Bank or gateway declined the payment. Specific reason not provided.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_method",
  },

  payment_failed: {
    customerMessage: "The payment could not be processed. No money was deducted. Please try again or use a different payment method.",
    vendorMessage: "Payment processing failed at the bank or gateway. No specific error code received.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "retry_later",
  },

  payment_pending: {
    customerMessage: "Your payment is being processed. This may take a few minutes. Please wait and check back later.",
    vendorMessage: "Payment is pending at the bank. May become authorized later (late authorization).",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "retry_later",
  },

  payment_session_expired: {
    customerMessage: "Your payment session expired. Please start the payment again.",
    vendorMessage: "Payment session expired due to inactivity.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "retry_now",
  },

  payment_declined_due_to_high_traffic: {
    customerMessage: "Due to high traffic, your bank couldn't process the payment right now. Please try again in a few minutes.",
    vendorMessage: "Bank unable to serve requests due to high traffic (e.g., peak hours).",
    failureClass: "NETWORK_TIMEOUT",
    recommendedAction: "retry_later",
  },

  // ═══════════════════════════════════════════════════════════════════
  // RISK / SECURITY
  // ═══════════════════════════════════════════════════════════════════

  payment_risk_check_failed: {
    customerMessage: "This transaction was flagged for a security review by your bank. Please try a different card or contact your bank.",
    vendorMessage: "Transaction declined by bank due to risk/fraud checks.",
    failureClass: "RISK_FLAGGED",
    recommendedAction: "vendor_review",
  },

  compliance_violation: {
    customerMessage: "This transaction couldn't be completed due to a compliance check. Please contact support for help.",
    vendorMessage: "Transaction blocked due to compliance violation at customer or merchant level.",
    failureClass: "RISK_FLAGGED",
    recommendedAction: "contact_support",
  },

  // ═══════════════════════════════════════════════════════════════════
  // NETBANKING ERRORS
  // ═══════════════════════════════════════════════════════════════════

  user_not_registered_for_netbanking: {
    customerMessage: "Your bank account is not registered for netbanking. Please register through your bank's website first.",
    vendorMessage: "Customer's bank account is not registered for netbanking.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_method",
  },

  bank_not_available: {
    customerMessage: "Your bank is currently unavailable due to maintenance or a technical issue. Please try again later.",
    vendorMessage: "Bank is down or experiencing technical issues.",
    failureClass: "NETWORK_TIMEOUT",
    recommendedAction: "retry_later",
  },

  // ═══════════════════════════════════════════════════════════════════
  // SERVER / INFRASTRUCTURE ERRORS
  // ═══════════════════════════════════════════════════════════════════

  server_error: {
    customerMessage: "We're facing a temporary technical issue. No money was deducted. Please try again in a few minutes.",
    vendorMessage: "Technical error at Razorpay's server.",
    failureClass: "NETWORK_TIMEOUT",
    recommendedAction: "retry_later",
  },

  gateway_error: {
    customerMessage: "There's a temporary issue with the payment gateway. No money was deducted. Please try again shortly.",
    vendorMessage: "Error at the payment gateway or downstream bank.",
    failureClass: "NETWORK_TIMEOUT",
    recommendedAction: "retry_later",
  },

  service_unavailable: {
    customerMessage: "The payment service is temporarily unavailable. Please try again in a few minutes.",
    vendorMessage: "Payment service is temporarily unavailable (transient condition).",
    failureClass: "NETWORK_TIMEOUT",
    recommendedAction: "retry_later",
  },

  request_timed_out: {
    customerMessage: "The request timed out due to a slow connection. No money was deducted. Please try again.",
    vendorMessage: "Request timed out. Possible network or server latency.",
    failureClass: "NETWORK_TIMEOUT",
    recommendedAction: "retry_now",
  },

  // ═══════════════════════════════════════════════════════════════════
  // AMOUNT / ORDER ERRORS
  // ═══════════════════════════════════════════════════════════════════

  order_already_paid: {
    customerMessage: "This order has already been paid for. No further payment is needed.",
    vendorMessage: "Order already has a successful payment. Duplicate attempt.",
    failureClass: "UNKNOWN",
    recommendedAction: "no_action",
  },

  order_amount_mismatch: {
    customerMessage: "The payment amount doesn't match the order. Please try again from the beginning.",
    vendorMessage: "Payment amount doesn't match the order amount.",
    failureClass: "UNKNOWN",
    recommendedAction: "retry_now",
  },

  invalid_amount: {
    customerMessage: "The payment amount is not valid. Please try again.",
    vendorMessage: "Invalid payment amount in the request.",
    failureClass: "UNKNOWN",
    recommendedAction: "contact_support",
  },

  amount_less_than_minimum_amount: {
    customerMessage: "The payment amount is too small. Please try with a higher amount.",
    vendorMessage: "Payment amount is less than the minimum allowed.",
    failureClass: "UNKNOWN",
    recommendedAction: "contact_support",
  },

  payment_amount_tampered: {
    customerMessage: "The payment amount was modified. Please try again from the beginning.",
    vendorMessage: "Payment amount was tampered with in the request.",
    failureClass: "RISK_FLAGGED",
    recommendedAction: "vendor_review",
  },

  // ═══════════════════════════════════════════════════════════════════
  // MANDATE / AUTOPAY ERRORS
  // ═══════════════════════════════════════════════════════════════════

  mandate_creation_declined: {
    customerMessage: "The automatic payment setup was declined. Please try setting it up again.",
    vendorMessage: "UPI Autopay/OTM mandate creation was declined.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_method",
  },

  mandate_creation_expired: {
    customerMessage: "The automatic payment setup request expired. Please try again.",
    vendorMessage: "Mandate creation request expired.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "retry_now",
  },

  mandate_creation_timeout: {
    customerMessage: "The automatic payment setup timed out. Please try again.",
    vendorMessage: "Mandate creation timed out.",
    failureClass: "NETWORK_TIMEOUT",
    recommendedAction: "retry_later",
  },

  funds_blocked_by_mandate: {
    customerMessage: "Your funds are blocked by an existing mandate. Please release the mandate or use a different account.",
    vendorMessage: "Funds are blocked by an existing mandate. Customer trying to access blocked funds.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_method",
  },

  // ═══════════════════════════════════════════════════════════════════
  // PSP / UPI APP ERRORS
  // ═══════════════════════════════════════════════════════════════════

  psp_not_available: {
    customerMessage: "Your UPI app is currently unavailable. Please try again or use a different UPI app.",
    vendorMessage: "PSP (UPI app) is unavailable due to downtime.",
    failureClass: "NETWORK_TIMEOUT",
    recommendedAction: "retry_later",
  },

  psp_app_not_available: {
    customerMessage: "Your UPI app is currently unavailable. Please try again or use a different UPI app.",
    vendorMessage: "PSP app is unavailable due to downtime.",
    failureClass: "NETWORK_TIMEOUT",
    recommendedAction: "retry_later",
  },

  psp_app_not_supported: {
    customerMessage: "Your UPI app is not supported for this payment. Please use a different UPI app.",
    vendorMessage: "Customer's UPI app is blacklisted or not supported.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_method",
  },

  psp_not_registered: {
    customerMessage: "Your UPI app is not registered on this device. Please register first and try again.",
    vendorMessage: "PSP is not registered on the customer's device.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_method",
  },

  invalid_device: {
    customerMessage: "This device is not registered for UPI payments. Please complete device binding first.",
    vendorMessage: "Customer is using an unregistered device for UPI payments.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_method",
  },

  pin_not_set: {
    customerMessage: "You haven't set a UPI PIN yet. Please set your UPI PIN first and try again.",
    vendorMessage: "Customer hasn't set a UPI PIN for their account.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_method",
  },

  bank_account_invalid: {
    customerMessage: "The bank account you're using is not valid. It may have been closed. Please use a different account.",
    vendorMessage: "Customer's bank account is invalid or closed.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_method",
  },

  // ═══════════════════════════════════════════════════════════════════
  // EMI / CREDIT ERRORS
  // ═══════════════════════════════════════════════════════════════════

  credit_limit_exceeded: {
    customerMessage: "You've exceeded your credit limit. Please use a different payment method.",
    vendorMessage: "Customer exceeded their credit limit (Cardless EMI).",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_method",
  },

  credit_limit_expired: {
    customerMessage: "Your credit limit has expired. Please use a different payment method.",
    vendorMessage: "Customer's credit limit has expired (Cardless EMI).",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_method",
  },

  credit_limit_inactive: {
    customerMessage: "Your credit limit is inactive. Please activate it or use a different payment method.",
    vendorMessage: "Customer's credit limit is inactive (Cardless EMI).",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_method",
  },

  credit_limit_not_approved: {
    customerMessage: "Your credit limit is not approved. Please use a different payment method.",
    vendorMessage: "Customer's credit limit is not approved (Cardless EMI).",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_method",
  },

  user_not_eligible: {
    customerMessage: "You're not eligible for this credit-based payment. Please use a different payment method.",
    vendorMessage: "Customer failed eligibility check for credit/EMI.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_method",
  },

  emi_plan_unavailable: {
    customerMessage: "The EMI plan you selected is no longer available. Please choose a different plan or payment method.",
    vendorMessage: "Customer's selected EMI plan is no longer supported.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_method",
  },

  // ═══════════════════════════════════════════════════════════════════
  // MISCELLANEOUS / EDGE CASES
  // ═══════════════════════════════════════════════════════════════════

  duplicate_request: {
    customerMessage: "This payment was already attempted. Please check your order status.",
    vendorMessage: "Duplicate payment initiation request with same parameters.",
    failureClass: "UNKNOWN",
    recommendedAction: "no_action",
  },

  invalid_order_id: {
    customerMessage: "There's an issue with your order. Please try again from the beginning.",
    vendorMessage: "Order ID is missing or invalid in the payment request.",
    failureClass: "UNKNOWN",
    recommendedAction: "retry_now",
  },

  input_validation_failed: {
    customerMessage: "There's an issue with your payment details. Please check and try again.",
    vendorMessage: "Payment request has invalid parameters.",
    failureClass: "UNKNOWN",
    recommendedAction: "check_card_details",
  },

  live_mode_not_enabled: {
    customerMessage: "Live payments are not enabled for this merchant. Please contact support.",
    vendorMessage: "Live mode is not enabled for the merchant. Using test keys for live payment.",
    failureClass: "UNKNOWN",
    recommendedAction: "contact_support",
  },

  payment_method_not_enabled: {
    customerMessage: "This payment method is not available. Please choose a different way to pay.",
    vendorMessage: "Selected payment method is not enabled for this merchant.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_method",
  },

  international_transaction_not_allowed: {
    customerMessage: "International cards are not accepted for this payment. Please use a domestic card.",
    vendorMessage: "International transactions are not enabled for this merchant/account.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_card",
  },

  record_not_found: {
    customerMessage: "We couldn't find your payment record. Please try again.",
    vendorMessage: "Payment record not found at the bank. Status check failed.",
    failureClass: "NETWORK_TIMEOUT",
    recommendedAction: "retry_later",
  },

  deemed_transaction: {
    customerMessage: "Your payment status is being verified. This may take up to 24 hours. Please check back later.",
    vendorMessage: "Deemed transaction — status unknown to acquirer. Will be resolved next day.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "retry_later",
  },

  verification_failed: {
    customerMessage: "We couldn't verify your payment status. Please try again.",
    vendorMessage: "Payment verification using status check API failed. Temporary error.",
    failureClass: "NETWORK_TIMEOUT",
    recommendedAction: "retry_later",
  },

  bank_cutoff_in_progress: {
    customerMessage: "Your bank is currently processing its daily settlement. Please try again in a few minutes.",
    vendorMessage: "Bank CBS (Core Banking System) cutoff is in progress.",
    failureClass: "NETWORK_TIMEOUT",
    recommendedAction: "retry_later",
  },

  collect_on_mcc_blocked: {
    customerMessage: "UPI collect is not allowed for this type of payment. Please try a different payment method.",
    vendorMessage: "NPCI blocks collect requests on certain MCCs.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_method",
  },

  mcc_amount_limit_exceeded: {
    customerMessage: "The payment amount exceeds the limit for this payment type. Please try a different payment method.",
    vendorMessage: "NPCI restricts collect requests over ₹5k for certain MCCs.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_method",
  },

  transaction_frequency_limit_exceeded: {
    customerMessage: "You've exceeded the daily UPI transaction limit. Please try again tomorrow or use a different payment method.",
    vendorMessage: "Customer exceeded NPCI's daily UPI transaction frequency/amount limit.",
    failureClass: "SOFT_RETRYABLE",
    recommendedAction: "use_different_method",
  },

  transaction_on_vpa_restricted: {
    customerMessage: "Transactions on this UPI ID have been temporarily restricted. Please use a different UPI ID.",
    vendorMessage: "Transaction on this VPA is temporarily/permanently blocked by the PSP.",
    failureClass: "HARD_METHOD_DEAD",
    recommendedAction: "use_different_method",
  },

  merchant_not_activated: {
    customerMessage: "This merchant is not activated for payments. Please contact support.",
    vendorMessage: "Merchant is not activated with the payment gateway.",
    failureClass: "UNKNOWN",
    recommendedAction: "contact_support",
  },

  // ═══════════════════════════════════════════════════════════════════
  // FALLBACK (when error code not found)
  // ═══════════════════════════════════════════════════════════════════

  UNKNOWN: {
    customerMessage: "Something went wrong with your payment. No money was deducted. Please try again or use a different payment method.",
    vendorMessage: "Payment failed due to an unexpected error.",
    failureClass: "UNKNOWN",
    recommendedAction: "retry_later",
  },
};

// ── Lookup Helpers ────────────────────────────────────────────────

/**
 * Get the catalog entry for a Razorpay error code.
 * Falls back to UNKNOWN if not found.
 */
export function getErrorEntry(code: string): ErrorCatalogEntry {
  const normalized = (code || "").trim().toLowerCase();
  return RAZORPAY_ERROR_CATALOG[normalized] || RAZORPAY_ERROR_CATALOG["UNKNOWN"];
}

/**
 * Get simplified customer-facing message for a failure.
 * NEVER returns raw error codes.
 */
export function getCustomerMessage(code: string, description?: string): string {
  const entry = getErrorEntry(code);
  return entry.customerMessage;
}

/**
 * Get simplified vendor-facing message for a failure.
 * NEVER returns raw error codes.
 */
export function getVendorMessage(code: string, description?: string): string {
  const entry = getErrorEntry(code);
  return entry.vendorMessage;
}

/**
 * Get failure class for ML pipeline.
 */
export function getFailureClass(code: string): FailureClass {
  return getErrorEntry(code).failureClass;
}

/**
 * Get recommended AI action.
 */
export function getRecommendedAction(code: string): RecommendedAction {
  return getErrorEntry(code).recommendedAction;
}

/**
 * All error codes as an array (for round-robin, training data, etc.)
 */
export const ALL_ERROR_CODES = Object.keys(RAZORPAY_ERROR_CATALOG).filter((k) => k !== "UNKNOWN");

/**
 * Get error codes filtered by failure class.
 */
export function getErrorCodesByClass(cls: FailureClass): string[] {
  return ALL_ERROR_CODES.filter((code) => RAZORPAY_ERROR_CATALOG[code].failureClass === cls);
}

/**
 * Generate a round-robin iterator over ALL error codes.
 * Used for demo/testing to cycle through every possible failure.
 */
export function* errorRoundRobin(): Generator<{ code: string; entry: ErrorCatalogEntry }> {
  let idx = 0;
  while (true) {
    const code = ALL_ERROR_CODES[idx % ALL_ERROR_CODES.length];
    yield { code, entry: RAZORPAY_ERROR_CATALOG[code] };
    idx++;
  }
}
