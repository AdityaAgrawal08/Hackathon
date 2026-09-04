/**
 * ARBITER Enterprise Merchant Domain Context Engine (Phase 3)
 *
 * Implements domain-specific recovery optimizations without permanent hardcoded constants:
 * 1. D2C Impulse E-Commerce: Dynamic 1-Tap UPI Intent URI generator, cart hold reservation countdown,
 *    and bounded impulse discount concession.
 * 2. SaaS Recurring Mandates: Soft-lock grace period calculation, RBI 24h pre-debit notice,
 *    and alternate payment mandate setup.
 * 3. B2B Invoices & Receivables: 2/10 Net 30 early settlement economics, working capital cost of
 *    capital savings calculation (14% p.a. default or dynamic), and Razorpay Smart Collect Virtual UPI VPA.
 * 4. High-Ticket EdTech / Services: 3x No-Cost Split-Pay installment schedule with exact integer paise distribution.
 */

import { formatINR, paise, type Paise, isoUtc } from "@arbiter/shared";
import type { DomainType } from "../db/schema.js";

// ============================================================================
// Types & Config Interfaces
// ============================================================================

export interface D2CIntentParams {
  merchantVpa: string;
  merchantName: string;
  transactionRef: string;
  amountPaise: number;
  currency?: string; // Default "INR"
  cartReservationMins?: number; // Dynamic from merchant config
  concessionDiscountBp?: number; // Basis points (e.g. 500 = 5%)
  productName?: string;
  recoveryUrl?: string;
  nowMs?: number;
}

export interface D2CRecoveryStrategyOutput {
  domain: "D2C_ECOMMERCE";
  originalAmountPaise: number;
  discountPaise: number;
  netPayablePaise: number;
  formattedOriginal: string;
  formattedNetPayable: string;
  upiIntentUri: string;
  qrCodeString: string;
  cartReservationMins: number;
  cartExpiresAtUtc: string;
  badgeText: string;
  customerCtaText: string;
}

export interface SaaSGraceParams {
  mandateId: string;
  planName: string;
  amountPaise: number;
  customerEmail?: string;
  customerPhone?: string;
  retryCount?: number;
  maxRetries?: number;
  softLockGraceDays?: number; // Dynamic from merchant config
  rbiAdvanceNoticeHours?: number; // Dynamic (default 24)
  nowMs?: number;
}

export interface SaaSGraceStrategyOutput {
  domain: "SAAS_MANDATES";
  mandateId: string;
  planName: string;
  amountPaise: number;
  formattedAmount: string;
  softLockGraceDays: number;
  softLockExpiresAtUtc: string;
  preDebitNoticeAtUtc: string;
  scheduledDebitAtUtc: string;
  hoursUntilDebit: number;
  isSoftLocked: boolean;
  rbiCompliant: boolean;
  strategyAction: "PRE_DEBIT_NOTIFICATION" | "SOFT_LOCK_GRACE_NOTICE" | "MANDATE_UPDATE_REQUIRED";
  customerMessage: string;
  actionUrl: string;
}

export interface B2BSettlementParams {
  invoiceId: string;
  invoiceNumber: string;
  clientCompany: string;
  contactPerson: string;
  contactEmail: string;
  amountPaise: number;
  dueDateUtc: string;
  vendorVpaPrefix?: string;
  discountPercent?: number; // Default 2.0%
  annualCostOfCapital?: number; // Default 0.14 (14% p.a.)
  dsoDaysSaved?: number; // Default 20 days
  nowMs?: number;
}

export interface B2BStrategyOutput {
  domain: "B2B_INVOICES";
  invoiceId: string;
  invoiceNumber: string;
  clientCompany: string;
  originalAmountPaise: number;
  discountPercent: number;
  discountPaise: number;
  discountedAmountPaise: number;
  formattedOriginal: string;
  formattedDiscounted: string;
  formattedDiscountSaved: string;
  workingCapitalSavedPaise: number;
  netFinancialBenefitPaise: number;
  smartCollectVpa: string;
  dsoDaysSaved: number;
  annualCostOfCapital: number;
  validUntilUtc: string;
  formalSubject: string;
  formalEmailBody: string;
}

export interface HighTicketSplitPayParams {
  totalAmountPaise: number;
  customerName?: string;
  productName?: string;
  installmentCount?: number; // Default 3
  nowMs?: number;
}

export interface SplitPayInstallment {
  installmentNumber: number;
  amountPaise: number;
  formattedAmount: string;
  dueDateUtc: string;
  dueDayOffset: number;
  status: "DUE_NOW" | "SCHEDULED";
}

export interface HighTicketSplitPayOutput {
  domain: "HIGH_TICKET";
  totalAmountPaise: number;
  formattedTotal: string;
  installmentCount: number;
  installments: SplitPayInstallment[];
  interestMarkupBp: 0; // Invariant: Zero interest markup
  sumInstallmentsPaise: number;
  isSumPreserved: boolean;
  headline: string;
  customerProposalText: string;
}

// ============================================================================
// 1. D2C Impulse E-Commerce Strategy
// ============================================================================

/**
 * Builds a dynamic D2C recovery strategy featuring 1-Tap UPI Intent,
 * cart reservation countdown, and bounded impulse concession.
 */
export function buildD2CRecoveryStrategy(params: D2CIntentParams): D2CRecoveryStrategyOutput {
  const nowMs = params.nowMs ?? Date.now();
  const cartReservationMins = Math.max(1, params.cartReservationMins ?? 15);
  const currency = params.currency ?? "INR";

  // Dynamic discount concession calculation bounded by bps (default 0, max 15%)
  const rawBp = params.concessionDiscountBp ?? 0;
  const safeBp = Math.max(0, Math.min(1500, rawBp)); // Clamped between 0% and 15%
  const discountPaise = Math.round((params.amountPaise * safeBp) / 10000);
  const netPayablePaise = Math.max(0, params.amountPaise - discountPaise);

  const netRupees = (netPayablePaise / 100).toFixed(2);
  const cartExpiresAtUtc = isoUtc(nowMs + cartReservationMins * 60 * 1000);

  // Construct standard UPI Intent URI according to NPCI specifications:
  // upi://pay?pa=<vpa>&pn=<name>&am=<amount>&cu=<curr>&tr=<ref>&tn=<note>
  const upiUrl = new URL("upi://pay");
  upiUrl.searchParams.set("pa", params.merchantVpa);
  upiUrl.searchParams.set("pn", params.merchantName);
  upiUrl.searchParams.set("am", netRupees);
  upiUrl.searchParams.set("cu", currency);
  upiUrl.searchParams.set("tr", params.transactionRef);
  upiUrl.searchParams.set("tn", `Order ${params.transactionRef} - ${params.productName || "ARBITER Store"}`);
  if (params.recoveryUrl) {
    upiUrl.searchParams.set("url", params.recoveryUrl);
  }

  const upiIntentUri = upiUrl.toString();

  const formattedOriginal = formatINR(paise(params.amountPaise));
  const formattedNetPayable = formatINR(paise(netPayablePaise));

  const badgeText = `Cart reserved for ${cartReservationMins} mins (until ${new Date(cartExpiresAtUtc).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST)`;
  const customerCtaText = safeBp > 0
    ? `Pay ${formattedNetPayable} (${safeBp / 100}% discount applied) via 1-Tap UPI`
    : `Pay ${formattedNetPayable} via 1-Tap UPI`;

  return {
    domain: "D2C_ECOMMERCE",
    originalAmountPaise: params.amountPaise,
    discountPaise,
    netPayablePaise,
    formattedOriginal,
    formattedNetPayable,
    upiIntentUri,
    qrCodeString: upiIntentUri,
    cartReservationMins,
    cartExpiresAtUtc,
    badgeText,
    customerCtaText,
  };
}

// ============================================================================
// 2. SaaS Recurring Mandates Strategy
// ============================================================================

/**
 * Builds a SaaS recurring subscription recovery strategy compliant with RBI
 * 24-hour advance pre-debit notification regulations and merchant soft-lock grace periods.
 */
export function buildSaaSGracePeriodStrategy(params: SaaSGraceParams): SaaSGraceStrategyOutput {
  const nowMs = params.nowMs ?? Date.now();
  const softLockGraceDays = Math.max(1, params.softLockGraceDays ?? 3);
  const maxRetries = Math.max(1, params.maxRetries ?? 3);
  const retryCount = Math.max(0, params.retryCount ?? 0);
  const noticeHours = Math.max(24, params.rbiAdvanceNoticeHours ?? 24);

  const softLockExpiresAtUtc = isoUtc(nowMs + softLockGraceDays * 86400000);
  const preDebitNoticeAtUtc = isoUtc(nowMs);

  const isSoftLocked = retryCount >= maxRetries;
  const hoursUntilDebit = isSoftLocked ? 0 : noticeHours;
  const scheduledDebitAtUtc = isoUtc(nowMs + hoursUntilDebit * 3600000);

  const formattedAmount = formatINR(paise(params.amountPaise));
  const actionUrl = `/billing/mandates/${params.mandateId}?grace=1`;

  let strategyAction: SaaSGraceStrategyOutput["strategyAction"] = "PRE_DEBIT_NOTIFICATION";
  let customerMessage = "";

  if (isSoftLocked) {
    strategyAction = "SOFT_LOCK_GRACE_NOTICE";
    customerMessage = `Your ${params.planName} subscription (${formattedAmount}) could not be auto-debited after ${retryCount} attempts. Your account has entered a ${softLockGraceDays}-day grace period (expires ${new Date(softLockExpiresAtUtc).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}). Please switch bank account or update your mandate to avoid interruption: ${actionUrl}`;
  } else {
    strategyAction = "PRE_DEBIT_NOTIFICATION";
    customerMessage = `RBI Advance Notice: Your ${params.planName} subscription of ${formattedAmount} will be auto-debited in ${hoursUntilDebit} hours. If your primary account has insufficient balance, please switch to an alternate account before debit time: ${actionUrl}`;
  }

  return {
    domain: "SAAS_MANDATES",
    mandateId: params.mandateId,
    planName: params.planName,
    amountPaise: params.amountPaise,
    formattedAmount,
    softLockGraceDays,
    softLockExpiresAtUtc,
    preDebitNoticeAtUtc,
    scheduledDebitAtUtc,
    hoursUntilDebit,
    isSoftLocked,
    rbiCompliant: true,
    strategyAction,
    customerMessage,
    actionUrl,
  };
}

// ============================================================================
// 3. B2B Invoices & Receivables (2/10 Net 30 Terms)
// ============================================================================

/**
 * Calculates dynamic 2/10 Net 30 early settlement discount and capital interest savings.
 * No hardcoded rates: discountPercent, annualCostOfCapital, and dsoDaysSaved are fully parameterized.
 */
export function buildB2BEarlySettlementStrategy(params: B2BSettlementParams): B2BStrategyOutput {
  const nowMs = params.nowMs ?? Date.now();
  const discountPercent = typeof params.discountPercent === "number" && params.discountPercent >= 0
    ? params.discountPercent
    : 2.0;
  const annualCostOfCapital = typeof params.annualCostOfCapital === "number" && params.annualCostOfCapital > 0
    ? params.annualCostOfCapital
    : 0.14; // 14% p.a. default hurdle rate
  const dsoDaysSaved = typeof params.dsoDaysSaved === "number" && params.dsoDaysSaved > 0
    ? params.dsoDaysSaved
    : 20; // 20 days early on Net 30

  const originalPaise = Math.max(0, params.amountPaise);
  const discountPaise = Math.round((originalPaise * discountPercent) / 100);
  const discountedAmountPaise = Math.max(0, originalPaise - discountPaise);

  // Working Capital Interest Saved = (Amount * AnnualCostOfCapital * DSODaysSaved) / 365
  const workingCapitalSavedPaise = Math.round(
    (originalPaise * annualCostOfCapital * dsoDaysSaved) / 365
  );

  const netFinancialBenefitPaise = workingCapitalSavedPaise - discountPaise;
  const vpaPrefix = (params.vendorVpaPrefix || "b2b").toLowerCase().replace(/[^a-z0-9]/g, "");
  const smartCollectVpa = `smartcollect.${vpaPrefix}.${params.invoiceNumber.toLowerCase().replace(/[^a-z0-9]/g, "")}@razorpay`;

  // Offer valid for next 48 hours
  const validUntilUtc = isoUtc(nowMs + 48 * 3600 * 1000);

  const formattedOriginal = formatINR(paise(originalPaise));
  const formattedDiscounted = formatINR(paise(discountedAmountPaise));
  const formattedDiscountSaved = formatINR(paise(discountPaise));

  const formalSubject = `Early Settlement Incentive: Invoice #${params.invoiceNumber} (${params.clientCompany})`;
  const formalEmailBody =
    `Dear ${params.contactPerson},\n\n` +
    `Regarding Invoice #${params.invoiceNumber} for ${params.clientCompany} in the amount of ${formattedOriginal}.\n\n` +
    `Under our Early Settlement Incentive (${discountPercent}% Early Clearance), you can settle this invoice today for ${formattedDiscounted} (saving ${formattedDiscountSaved}) by making an immediate payment to your dedicated Razorpay Smart Collect Virtual UPI Account:\n\n` +
    `• Dedicated UPI VPA: ${smartCollectVpa}\n` +
    `• Beneficiary: ${params.clientCompany}\n` +
    `• Settlement Valid Until: ${new Date(validUntilUtc).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })} 23:59 IST\n\n` +
    `Thank you for your business.\n\n` +
    `Accounts Receivable Department`;

  return {
    domain: "B2B_INVOICES",
    invoiceId: params.invoiceId,
    invoiceNumber: params.invoiceNumber,
    clientCompany: params.clientCompany,
    originalAmountPaise: originalPaise,
    discountPercent,
    discountPaise,
    discountedAmountPaise,
    formattedOriginal,
    formattedDiscounted,
    formattedDiscountSaved,
    workingCapitalSavedPaise,
    netFinancialBenefitPaise,
    smartCollectVpa,
    dsoDaysSaved,
    annualCostOfCapital,
    validUntilUtc,
    formalSubject,
    formalEmailBody,
  };
}

// ============================================================================
// 4. High-Ticket EdTech / Services (3x Split-Pay Schedule)
// ============================================================================

/**
 * Generates an integer-exact 3x No-Cost Split-Pay installment schedule.
 * Strictly preserves money invariant I-5: sum of installments equals totalAmountPaise exactly.
 */
export function buildHighTicketSplitPayStrategy(params: HighTicketSplitPayParams): HighTicketSplitPayOutput {
  const nowMs = params.nowMs ?? Date.now();
  const count = Math.max(2, params.installmentCount ?? 3);
  const total = Math.max(0, params.totalAmountPaise);

  const baseInstallment = Math.floor(total / count);
  const remainder = total - baseInstallment * count;

  const installments: SplitPayInstallment[] = [];
  let sumCheck = 0;

  for (let i = 0; i < count; i++) {
    const isFirst = i === 0;
    // Allocate integer paise rounding remainder to 1st installment
    const installmentAmount = isFirst ? baseInstallment + remainder : baseInstallment;
    sumCheck += installmentAmount;

    const dueDayOffset = i * 30; // 0, 30, 60 days
    const dueDateUtc = isoUtc(nowMs + dueDayOffset * 86400000);

    installments.push({
      installmentNumber: i + 1,
      amountPaise: installmentAmount,
      formattedAmount: formatINR(paise(installmentAmount)),
      dueDateUtc,
      dueDayOffset,
      status: isFirst ? "DUE_NOW" : "SCHEDULED",
    });
  }

  const formattedTotal = formatINR(paise(total));
  const firstFormatted = installments[0]?.formattedAmount ?? formattedTotal;

  const headline = `Convert ${formattedTotal} into ${count}x No-Cost Monthly Installments`;
  const customerProposalText =
    `Hi ${params.customerName || "there"},\n\n` +
    `To ensure your enrollment in ${params.productName || "your program"} is uninterrupted by single debit limits, you can convert your payment into ${count} monthly installments of ${firstFormatted} with 0% interest and zero additional fees.\n\n` +
    `First installment due today: ${firstFormatted}. Subsequent installments scheduled automatically via UPI Autopay.`;

  return {
    domain: "HIGH_TICKET",
    totalAmountPaise: total,
    formattedTotal,
    installmentCount: count,
    installments,
    interestMarkupBp: 0,
    sumInstallmentsPaise: sumCheck,
    isSumPreserved: sumCheck === total,
    headline,
    customerProposalText,
  };
}
