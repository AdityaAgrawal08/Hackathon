/**
 * Track 3 Multi-Domain Revenue Recovery Engines
 * Covers:
 * 1. SaaS Recurring Subscription Mandates (UPI Autopay, eNACH)
 * 2. Magic Checkout Pre-Payment Cart Drop-Offs
 * 3. B2B Corporate Invoices & Receivables (2/10 Net 30 Terms)
 */
import { formatINR, paise, isoUtc } from "@arbiter/shared";

// ============================================================================
// 1. SaaS Recurring Subscription Mandates
// ============================================================================

export interface SubscriptionMandate {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  mandateType: "UPI_AUTOPAY" | "E_NACH" | "CARD_RECURRING";
  planName: string;
  amountPaise: number;
  lastFailureCode?: string;
  nextRetryAtUtc?: string;
  preDebitNotifiedAtUtc?: string;
  retrySequenceCount: number;
  maxRetries: number;
  status: "ACTIVE" | "RECOVERED" | "CANCELLED" | "SOFT_LOCK";
  createdAtUtc: string;
}

export interface MandateRetryPlan {
  mandateId: string;
  preDebitNotificationAtUtc: string;
  scheduledDebitAtUtc: string;
  hoursUntilDebit: number;
  rbiCompliant: boolean;
  strategy: "SALARY_WINDOW_0630" | "LIQUIDITY_RETRY" | "SOFT_LOCK_PROMPT";
  customerMessage: string;
}

/**
 * Schedules a subscription mandate debit retry in compliance with RBI 24-hour advance
 * pre-debit notification mandate (RBI Circular DPSS.CO.PD.No.447/02.14.003/2020-21).
 * Schedules execution for 06:30 AM IST (peak bank switch liquidity).
 */
export function scheduleMandateRetry(
  mandate: SubscriptionMandate,
  failureCode: string,
  nowMs: number = Date.now(),
): MandateRetryPlan {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const MIN_RBI_NOTICE_MS = 24 * 60 * 60 * 1000; // 24 hours required by RBI

  // If retries exhausted (>= maxRetries), transition to soft-lock
  if (mandate.retrySequenceCount >= mandate.maxRetries) {
    return {
      mandateId: mandate.id,
      preDebitNotificationAtUtc: new Date(nowMs).toISOString(),
      scheduledDebitAtUtc: new Date(nowMs).toISOString(),
      hoursUntilDebit: 0,
      rbiCompliant: true,
      strategy: "SOFT_LOCK_PROMPT",
      customerMessage: `Your ${mandate.planName} subscription mandate could not be processed after ${mandate.maxRetries} attempts. Your account has entered a grace period. Please update your payment method.`,
    };
  }

  // Pre-debit notification must be sent NOW
  const preDebitNotificationAtUtc = new Date(nowMs).toISOString();

  // Target time: Next day 06:30 AM IST (which is 01:00 AM UTC)
  // Ensure scheduled debit is at least 24h + 1h in future to guarantee strict RBI compliance
  const earliestDebitMs = nowMs + MIN_RBI_NOTICE_MS;
  const targetDateIST = new Date(earliestDebitMs + IST_OFFSET_MS);

  // Set to 06:30:00 IST
  targetDateIST.setUTCHours(6, 30, 0, 0);
  let scheduledDebitMs = targetDateIST.getTime() - IST_OFFSET_MS;

  // If 06:30 AM IST is sooner than the required 24 hours, push by 24 hours
  if (scheduledDebitMs < earliestDebitMs) {
    scheduledDebitMs += 24 * 60 * 60 * 1000;
  }

  const hoursUntilDebit = Math.round((scheduledDebitMs - nowMs) / (3600 * 1000));
  const formattedAmount = formatINR(paise(mandate.amountPaise));

  return {
    mandateId: mandate.id,
    preDebitNotificationAtUtc,
    scheduledDebitAtUtc: new Date(scheduledDebitMs).toISOString(),
    hoursUntilDebit,
    rbiCompliant: true,
    strategy: "SALARY_WINDOW_0630",
    customerMessage: `RBI Mandate Notice: Your ${mandate.planName} (${formattedAmount}) will be auto-debited via ${mandate.mandateType} on ${new Date(scheduledDebitMs).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })} at 06:30 AM. Ensure account liquidity.`,
  };
}

// ============================================================================
// 2. Abandoned Pre-Payment Checkouts
// ============================================================================

export interface AbandonedCheckout {
  id: string;
  customerName?: string;
  customerPhone: string;
  customerEmail?: string;
  cartItemsJson: string;
  cartAmountPaise: number;
  dropOffStep: "PHONE_ENTERED" | "ADDRESS_SUBMITTED" | "PAYMENT_SCREEN_EXITED";
  recoveryToken: string;
  status: "ABANDONED" | "SALVAGED" | "EXPIRED";
  createdAtUtc: string;
}

export interface CartRecoveryLink {
  checkoutId: string;
  recoveryUrl: string;
  token: string;
  expiresInMinutes: number;
  formattedAmount: string;
  customerMessage: string;
}

/**
 * Generates a 1-click cart restoration deep link with preserved cart state
 * and 15-minute price hold assurance.
 */
export function generateCartRecoveryLink(
  checkout: AbandonedCheckout,
  baseUrl: string = "http://localhost:3000",
): CartRecoveryLink {
  const recoveryUrl = `${baseUrl}/checkout/restore/${checkout.recoveryToken}`;
  const formattedAmount = formatINR(paise(checkout.cartAmountPaise));

  return {
    checkoutId: checkout.id,
    recoveryUrl,
    token: checkout.recoveryToken,
    expiresInMinutes: 15,
    formattedAmount,
    customerMessage: `Hi ${checkout.customerName || "there"}, we reserved your cart (${formattedAmount}) for the next 15 mins. Complete your order with 1-Tap UPI: ${recoveryUrl}`,
  };
}

// ============================================================================
// 3. B2B Corporate Invoices & Receivables (2/10 Net 30 Terms)
// ============================================================================

export interface B2BInvoice {
  id: string;
  vendorId: string;
  clientCompany: string;
  contactPerson: string;
  contactEmail: string;
  contactPhone?: string;
  amountPaise: number;
  invoiceNumber: string;
  dueDateUtc: string;
  daysOverdue: number;
  earlyDiscountPercent: number; // e.g. 2.0%
  virtualVpa?: string;
  status: "OVERDUE" | "PAID" | "DISCOUNT_APPLIED";
  createdAtUtc: string;
}

export interface InvoiceChaserPlan {
  invoiceId: string;
  originalAmountPaise: number;
  discountedAmountPaise: number;
  discountSavedPaise: number;
  virtualVpa: string;
  daysOverdue: number;
  workingCapitalSavedPaise: number;
  noticeUrgency: "GENTLE_COURTESY" | "EARLY_SETTLEMENT_OFFER" | "CREDIT_HOLD_NOTICE";
  formalSubject: string;
  formalNoticeBody: string;
}

/**
 * Calculates dynamic 2/10 Net 30 early settlement terms and working capital cost savings
 * based on Days Sales Outstanding (DSO) acceleration at 14% annual cost of capital.
 */
export function calculateEarlySettlementDiscount(
  invoice: B2BInvoice,
  nowMs: number = Date.now(),
): InvoiceChaserPlan {
  const ANNUAL_COST_OF_CAPITAL = 0.14; // 14% p.a.
  const originalPaise = invoice.amountPaise;

  // 2% early settlement discount
  const discountRate = invoice.earlyDiscountPercent / 100;
  const discountSavedPaise = Math.round(originalPaise * discountRate);
  const discountedAmountPaise = originalPaise - discountSavedPaise;

  // Working Capital Interest Saved = (Amount * 14% * 20 days DSO saved) / 365
  const dsoSavedDays = 20;
  const workingCapitalSavedPaise = Math.round(
    (originalPaise * ANNUAL_COST_OF_CAPITAL * dsoSavedDays) / 365,
  );

  const virtualVpa = invoice.virtualVpa || `smartcollect.${invoice.vendorId.toLowerCase()}@razorpay`;

  let noticeUrgency: InvoiceChaserPlan["noticeUrgency"] = "EARLY_SETTLEMENT_OFFER";
  let formalSubject = `Early Settlement Incentive: Invoice #${invoice.invoiceNumber} (${invoice.clientCompany})`;

  if (invoice.daysOverdue <= 5) {
    noticeUrgency = "GENTLE_COURTESY";
    formalSubject = `Payment Reminder: Invoice #${invoice.invoiceNumber} for ${invoice.clientCompany}`;
  } else if (invoice.daysOverdue >= 30) {
    noticeUrgency = "CREDIT_HOLD_NOTICE";
    formalSubject = `URGENT: Formal Overdue Notice & Credit Hold - Invoice #${invoice.invoiceNumber}`;
  }

  const originalFormatted = formatINR(paise(originalPaise));
  const discountedFormatted = formatINR(paise(discountedAmountPaise));
  const discountSavedFormatted = formatINR(paise(discountSavedPaise));

  const formalNoticeBody =
    `Dear ${invoice.contactPerson},\n\n` +
    `Invoice #${invoice.invoiceNumber} for ${invoice.clientCompany} (${originalFormatted}) is currently ${invoice.daysOverdue} days overdue.\n\n` +
    `Under our Early Settlement Incentive (2/10 Net 30), you can settle today for ${discountedFormatted} (saving ${discountSavedFormatted}) by transferring to your dedicated Razorpay Smart Collect Virtual Account:\n\n` +
    `• Virtual UPI ID: ${virtualVpa}\n` +
    `• Beneficiary: ${invoice.clientCompany}\n\n` +
    `This early settlement rate is valid for the next 48 hours.\n\n` +
    `Regards,\nFinance & Accounts Department`;

  return {
    invoiceId: invoice.id,
    originalAmountPaise: originalPaise,
    discountedAmountPaise,
    discountSavedPaise,
    virtualVpa,
    daysOverdue: invoice.daysOverdue,
    workingCapitalSavedPaise,
    noticeUrgency,
    formalSubject,
    formalNoticeBody,
  };
}

export * from "./merchant_context.js";
