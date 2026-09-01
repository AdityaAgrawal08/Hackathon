/**
 * Real Payment Workflow — processes failed Razorpay payments through the full pipeline:
 * webhook → error extraction → failure classification → ML scoring → EV decision → outreach dispatch.
 *
 * Replaces simulateFailureTriage with a real, production-grade pipeline.
 */
import type { Client } from "@libsql/client";
import { createHash } from "node:crypto";
import { isoUtc, paise, formatINR, logger } from "../packages/shared/src/index.js";
import { classifyByCode, computeFeatures, scoreWithArtifact, DEFAULT_16D_MODEL, assessCredibility } from "../packages/ml/src/index.js";
import { decide, defaultPolicy, type DecideOutput, type FailureClassId } from "../packages/core/src/decide/index.js";
import { OutreachRouter, type OutreachChannel, type OutreachPayload, type ProviderDispatchResult } from "../packages/core/src/messaging/index.js";
import { getErrorEntry, getCustomerMessage, getVendorMessage, getFailureClass as getCatalogFailureClass } from "../packages/core/src/error-catalog.js";

export interface Product {
  id: string;
  name: string;
  description: string;
  pricePaise: number;
  image: string;
}

export const PRODUCTS: Product[] = [
  {
    id: "prod_premium_plan",
    name: "Premium Annual Plan",
    description: "Full access to all features for 12 months",
    pricePaise: 499900,
    image: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect fill='%230f172a' width='200' height='200'/%3E%3Ctext fill='%23ffffff' x='100' y='90' text-anchor='middle' font-size='40' font-family='Arial'%3E★%3C/text%3E%3Ctext fill='%2394a3b8' x='100' y='120' text-anchor='middle' font-size='14' font-family='Arial'%3EPremium%3C/text%3E%3C/svg%3E",
  },
  {
    id: "prod_monthly_basic",
    name: "Monthly Basic",
    description: "Essential features, billed monthly",
    pricePaise: 99900,
    image: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect fill='%231e293b' width='200' height='200'/%3E%3Ctext fill='%23ffffff' x='100' y='90' text-anchor='middle' font-size='40' font-family='Arial'%3E◆%3C/text%3E%3Ctext fill='%2394a3b8' x='100' y='120' text-anchor='middle' font-size='14' font-family='Arial'%3EBasic%3C/text%3E%3C/svg%3E",
  },
  {
    id: "prod_team_license",
    name: "Team License (5 seats)",
    description: "Collaborate with your team, 5 user seats",
    pricePaise: 199900,
    image: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect fill='%23334155' width='200' height='200'/%3E%3Ctext fill='%23ffffff' x='100' y='90' text-anchor='middle' font-size='40' font-family='Arial'%3E⬡%3C/text%3E%3Ctext fill='%2394a3b8' x='100' y='120' text-anchor='middle' font-size='14' font-family='Arial'%3ETeam%3C/text%3E%3C/svg%3E",
  },
  {
    id: "prod_enterprise",
    name: "Enterprise (Custom)",
    description: "Custom solution for large organizations",
    pricePaise: 999900,
    image: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect fill='%23475569' width='200' height='200'/%3E%3Ctext fill='%23ffffff' x='100' y='90' text-anchor='middle' font-size='40' font-family='Arial'%3E⬢%3C/text%3E%3Ctext fill='%2394a3b8' x='100' y='120' text-anchor='middle' font-size='14' font-family='Arial'%3EEnterprise%3C/text%3E%3C/svg%3E",
  },
];

export function getProduct(productId: string): Product | undefined {
  return PRODUCTS.find((p) => p.id === productId);
}

export interface FailedPaymentInput {
  razorpayPaymentId: string;
  razorpayOrderId: string;
  amountPaise: number;
  failureCode: string;
  failureDescription: string;
  failureStep: string;
  failureSource: string;
  failureReason: string;
  customerProfileId: string;
  productName: string;
  nowMs: number;

  // Razorpay webhook: payment method details
  paymentMethod?: string;     // card, upi, netbanking, wallet, emi
  cardLast4?: string;         // Last 4 digits of card
  cardNetwork?: string;       // Visa, Mastercard, RuPay, AMEX
  cardIssuer?: string;        // Issuing bank (HDFC, SBI)
  cardType?: string;          // credit, debit
  cardEmi?: boolean;          // true if EMI payment

  // Razorpay webhook: UPI details
  vpa?: string;               // UPI VPA (user@upi)

  // Razorpay webhook: netbanking details
  bankCode?: string;          // Bank code (HDFC, KKBK)

  // Razorpay webhook: international flag
  isInternational?: boolean;  // true for international cards

  // Razorpay webhook: acquirer data
  acquirerAuthCode?: string;  // Bank authorization code
  acquirerRrn?: string;       // Network Reference Number (RRN)

  // Razorpay webhook: token and contact
  razorpayTokenId?: string;   // Saved instrument token
  razorpayContact?: string;   // Customer phone from webhook
  razorpayEmail?: string;     // Customer email from webhook
  razorpayCreatedAt?: number; // Payment created_at (epoch seconds)
}

export interface ProcessResult {
  eventId: string;
  failureClass: FailureClassId;
  probability: number;
  action: string;
  isSuspicious: boolean;
  suspicionReasons: string[];
  outreachDispatched: boolean;
  dispatchResults: ProviderDispatchResult[];
  scheduledOutreach: Array<{ channel: string; scheduledAtUtc: string }>;
}

export async function processFailedPayment(
  client: Client,
  input: FailedPaymentInput,
  outreachRouter: OutreachRouter,
): Promise<ProcessResult> {
  const nowMs = input.nowMs;
  const nowUtc = isoUtc(nowMs);

  // 1. Classify failure using Razorpay's error envelope (not hardcoded)
  const failureClass = classifyByCode(input.failureCode, {
    SOFT_RETRYABLE: [
      "INSUFFICIENT_FUNDS",
      "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
      "BAD_REQUEST_PAYMENT_UPI_COLLECT_EXPIRED",
      "BAD_REQUEST_PAYMENT_OTP_VALIDATION_FAILED",
      "TEMPORARY_DECLINE",
      "NO_MANDATE_RESPONSE",
      "LOCAL_INSUFFICIENT_FUNDS",
      "RZP_INSUFFICIENT_FUNDS",
    ],
    HARD_METHOD_DEAD: [
      "CARD_EXPIRED",
      "BAD_REQUEST_PAYMENT_CARD_EXPIRED",
      "BAD_REQUEST_PAYMENT_CARD_INVALID",
      "BAD_REQUEST_PAYMENT_MANDATE_REVOKED",
      "BAD_REQUEST_PAYMENT_UPI_INVALID_VPA",
      "MANDATE_REVOKED",
      "TOKEN_INVALID",
      "LOCAL_EXPIRED_METHOD",
      "LOCAL_INVALID_DETAILS",
      "RZP_EXPIRED_METHOD",
      "RZP_INVALID_DETAILS",
    ],
    NETWORK_TIMEOUT: [
      "GATEWAY_TIMEOUT",
      "GATEWAY_ERROR",
      "BANK_DOWNTIME_NETWORK_ERROR",
      "BAD_REQUEST_PAYMENT_TIMED_OUT",
      "ISSUER_TIMEOUT",
      "NETWORK_ERROR",
      "LOCAL_GATEWAY_TIMEOUT",
      "LOCAL_GATEWAY_503",
      "LOCAL_LOST_RESPONSE",
      "RZP_RATE_LIMITED",
      "RZP_SERVER_ERROR",
    ],
    RISK_FLAGGED: [
      "SUSPECTED_FRAUD",
      "BAD_REQUEST_PAYMENT_FRAUD_IDENTIFIED",
      "BAD_REQUEST_PAYMENT_CARD_STOLEN",
      "RISK_BLOCKED",
      "LOCAL_RISK_REJECTED",
      "RZP_REJECTED",
    ],
    UNKNOWN: [
      "BAD_REQUEST_PAYMENT_DECLINED_BY_BANK",
      "UNKNOWN_CODE",
      "UNKNOWN",
    ],
  });

  // 2. Fetch customer profile for ML context
  const custResult = await client.execute({
    sql: `SELECT * FROM customer_profiles WHERE id = ?`,
    args: [input.customerProfileId],
  });
  const customer = custResult.rows[0] as any;

  // 3. Compute ML features using customer history
  const priorAmounts: number[] = [];
  if (customer) {
    const priorEvents = await client.execute({
      sql: `SELECT amount_paise FROM live_payment_events WHERE customer_profile_id = ? AND status = 'failed' ORDER BY created_at_utc ASC`,
      args: [input.customerProfileId],
    });
    for (const row of priorEvents.rows) {
      priorAmounts.push(Number(row.amount_paise));
    }
  }

  const features = computeFeatures({
    failureCode: input.failureCode,
    amountPaise: input.amountPaise,
    occurredAtUtc: nowUtc,
    priorFailureAmountsPaise: priorAmounts,
    priorFailureCount: customer?.total_failures ?? 0,
    customer: {
      priorSuccessCount: customer?.total_successes ?? 0,
      joinedAtUtc: customer?.created_at_utc ?? nowUtc,
      // Derive from actual success ratio; null lets features engine use default (0.5)
      channelResponsiveness: (customer?.total_attempts ?? 0) > 0
        ? (customer.total_successes ?? 0) / customer.total_attempts
        : null,
      // paydayPattern not available in customer_profiles table (migration 0008) — null is correct sentinel
      paydayPattern: null,
    },
    // Payment method features (from Razorpay webhook)
    paymentMethod: input.paymentMethod,
    cardType: input.cardType,
    cardEmi: input.cardEmi,
    isInternational: input.isInternational,
  });

  // 4. Score with ML model
  const scoreResult = scoreWithArtifact(features.values, DEFAULT_16D_MODEL);
  const probability = scoreResult.probability;

  // 5. EV Decision
  const policy = defaultPolicy();
  const decideOutput = decide({
    probability,
    failureClass,
    amountPaise: input.amountPaise,
    nowMs,
    policy,
    attemptsSoFar: customer?.total_failures ?? 0,
    ltvPaise: (customer?.total_successes ?? 0) * input.amountPaise,
    churnRiskBp: (customer?.total_failures ?? 0) > 2 ? 4000 : 1000,
  });

  // 6. Credibility assessment (ML + rules)
  const credPriorAmounts = customer
    ? (await client.execute({
        sql: "SELECT amount_paise FROM live_payment_events WHERE customer_profile_id = ? ORDER BY created_at_utc DESC LIMIT 10",
        args: [input.customerProfileId],
      })).rows.map(r => Number(r.amount_paise))
    : [];
  const credResult = assessCredibility({
    customerProfile: customer ? {
      totalAttempts: customer.total_attempts,
      totalSuccesses: customer.total_successes,
      totalFailures: customer.total_failures,
      totalAmountPaise: customer.total_amount_paise,
      flaggedAsSuspicious: !!customer.flagged_as_suspicious,
      riskScoreBp: customer.risk_score_bp,
      createdAtUtc: customer.created_at_utc,
    } : null,
    failureClass,
    amountPaise: input.amountPaise,
    mlProbability: probability,
    mlAttributions: scoreResult.attributions ?? [],
    priorFailureAmountsPaise: credPriorAmounts,
    occurredAtUtc: nowUtc,
  });
  const suspicionReasons = credResult.reasons;
  const isSuspicious = credResult.isSuspicious;

  // 7. Log to live_payment_events with ALL Razorpay webhook fields
  // Dedup: same customer + same product = UPDATE existing row (retry), not INSERT new row
  // (order_id changes on every retry since recover.html creates new orders)
  const eventId = `evt_${nowMs}_${createHash("sha256").update(`${input.razorpayPaymentId}${nowMs}`).digest("hex").slice(0, 8)}`;

  const existingRow = await client.execute({
    sql: `SELECT id, retry_count, razorpay_payment_id, razorpay_order_id FROM live_payment_events
          WHERE customer_profile_id = ? AND product_name = ? AND status = 'failed'
          ORDER BY created_at_utc DESC LIMIT 1`,
    args: [input.customerProfileId, input.productName],
  });

  if (existingRow.rows.length > 0) {
    const existingPaymentId = String(existingRow.rows[0].razorpay_payment_id || "");
    const newPaymentId = String(input.razorpayPaymentId || "");
    const existingIsClientSide = existingPaymentId.startsWith("pay_client_");
    const newIsClientSide = newPaymentId.startsWith("pay_client_");
    const isSameEventDifferentSource = existingIsClientSide !== newIsClientSide;

    const existingOrderId = String(existingRow.rows[0].razorpay_order_id || "");
    const isNewOrder = existingOrderId && input.razorpayOrderId && existingOrderId !== input.razorpayOrderId;

    // NEW RETRY (different order): Treat as a completely new transaction — INSERT new row, dispatch outreach
    // Same-event webhook fill-in or same-order update: UPDATE existing row, return early (no outreach)
    if (!isNewOrder) {
      const existingId = String(existingRow.rows[0].id);
      const existingRetryCount = Number(existingRow.rows[0].retry_count || 0);
      const newRetryCount = isSameEventDifferentSource ? 0 : existingRetryCount + 1;

      await client.execute({
        sql: `UPDATE live_payment_events SET
          razorpay_payment_id = ?, razorpay_order_id = ?,
          failure_code = ?, failure_description = ?, failure_step = ?, failure_source = ?, failure_reason = ?,
          failure_class = ?, ml_probability = ?, ml_action = ?,
          payment_method = ?, card_last4 = ?, card_network = ?, card_issuer = ?, card_type = ?,
          vpa = ?, bank_code = ?,
          retry_count = ?,
          created_at_utc = ?
          WHERE id = ?`,
        args: [
          input.razorpayPaymentId, input.razorpayOrderId,
          input.failureCode, input.failureDescription, input.failureStep, input.failureSource, input.failureReason,
          failureClass, probability, decideOutput.chosen.action,
          input.paymentMethod || "unknown", input.cardLast4 || null, input.cardNetwork || null,
          input.cardIssuer || null, input.cardType || null,
          input.vpa || null, input.bankCode || null,
          newRetryCount, nowUtc, existingId,
        ],
      });
      logger.info({ msg: `${isSameEventDifferentSource ? 'Webhook fill-in' : 'Update'}: event ${existingId} (retry #${newRetryCount})`, event: existingId, retryCount: newRetryCount });

      await client.execute({
        sql: `UPDATE customer_profiles SET
          total_attempts = total_attempts + 1, total_failures = total_failures + 1,
          last_failure_code = ?, last_failure_at_utc = ?, flagged_as_suspicious = ?, risk_score_bp = MAX(risk_score_bp, ?)
          WHERE id = ?`,
        args: [input.failureCode, nowUtc, isSuspicious ? 1 : 0, isSuspicious ? 3000 : 0, input.customerProfileId],
      });

      // NO outreach for same-event updates — this is a webhook filling in data for an already-tracked failure
      return {
        eventId: existingId, failureClass, action: decideOutput.chosen.action, probability,
        isSuspicious, suspicionReasons,
        outreachDispatched: false,
        dispatchResults: [],
        scheduledOutreach: [],
      };
    }
    // isNewOrder=true: fall through to INSERT below (new independent transaction)
    logger.info({ msg: `New retry order ${input.razorpayOrderId}: creating new transaction (original was ${existingRow.rows[0].id})`, orderId: input.razorpayOrderId, originalEventId: existingRow.rows[0].id });
  }

  // FIRST ATTEMPT / NEW RETRY ORDER: Insert new row
  await client.execute({
    sql: `INSERT INTO live_payment_events
      (id, razorpay_payment_id, razorpay_order_id, customer_profile_id, product_name, amount_paise,
       status, failure_code, failure_description, failure_step, failure_source, failure_reason,
       failure_class, ml_probability, ml_action, outreach_dispatched, vendor_notified, created_at_utc,
       payment_method, card_last4, card_network, card_issuer, card_type, card_emi,
       vpa, bank_code, is_international,
       acquirer_auth_code, acquirer_rrn,
       razorpay_token_id, razorpay_contact, razorpay_email, razorpay_created_at,
       customer_name, customer_phone, customer_email)
      VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?,
              ?, ?, ?,
              ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?)`,
    args: [
      eventId,
      input.razorpayPaymentId,
      input.razorpayOrderId,
      input.customerProfileId,
      input.productName,
      input.amountPaise,
      input.failureCode,
      input.failureDescription,
      input.failureStep,
      input.failureSource,
      input.failureReason,
      failureClass,
      probability,
      decideOutput.chosen.action,
      false,
      0, // vendor_notified — false at INSERT time, set to 1 only when vendor is actually notified
      nowUtc,
      // New Razorpay webhook fields
      input.paymentMethod || "unknown",
      input.cardLast4 || null,
      input.cardNetwork || null,
      input.cardIssuer || null,
      input.cardType || null,
      input.cardEmi ? 1 : 0,
      input.vpa || null,
      input.bankCode || null,
      input.isInternational ? 1 : 0,
      input.acquirerAuthCode || null,
      input.acquirerRrn || null,
      input.razorpayTokenId || null,
      input.razorpayContact || null,
      input.razorpayEmail || null,
      input.razorpayCreatedAt || null,
      // Snapshot customer data at transaction time
      customer?.name || null,
      customer?.phone || null,
      customer?.email || null,
    ],
  });

  // 8. Update customer profile
  await client.execute({
    sql: `UPDATE customer_profiles SET
      total_attempts = total_attempts + 1,
      total_failures = total_failures + 1,
      last_failure_code = ?,
      last_failure_at_utc = ?,
      flagged_as_suspicious = ?,
      risk_score_bp = MAX(risk_score_bp, ?)
      WHERE id = ?`,
    args: [
      input.failureCode,
      nowUtc,
      isSuspicious ? 1 : 0,
      isSuspicious ? 3000 : 0,
      input.customerProfileId,
    ],
  });

  // 9. Dispatch outreach if not suspicious
  const dispatchResults: ProviderDispatchResult[] = [];
  const scheduledOutreach: Array<{ channel: string; scheduledAtUtc: string }> = [];

  if (!isSuspicious) {
    // Immediate outreach via primary channels (Email + SMS only, no WhatsApp/Voice)
    // Build recovery URL with product info so customer's cart is restored
    const baseUrl = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").replace(/\/$/, "")
      || (process.env.NODE_ENV === "test" ? "http://localhost:3000" : `http://localhost:${process.env.PORT || "3000"}`);
    const recoveryUrl = new URL(`/recover/${eventId}`, baseUrl);
    if (input.productName) {
      // Map product name back to product ID
      const productMap: Record<string, string> = {
        "Premium Annual Plan": "prod_premium_plan",
        "Monthly Basic": "prod_monthly_basic",
        "Team License (5 seats)": "prod_team_license",
        "Enterprise (Custom)": "prod_enterprise",
      };
      const pid = productMap[input.productName] || input.productName;
      recoveryUrl.searchParams.set("product", pid);
      recoveryUrl.searchParams.set("productName", input.productName);
    }
    // Include failure class info in URL for recovery page UI
    recoveryUrl.searchParams.set("class", failureClass);
    recoveryUrl.searchParams.set("code", input.failureCode);
    recoveryUrl.searchParams.set("reason", input.failureReason || input.failureDescription);

    // Include payment method details in URL so recovery page can display them
    if (input.paymentMethod) recoveryUrl.searchParams.set("method", input.paymentMethod);
    if (input.cardLast4) recoveryUrl.searchParams.set("last4", input.cardLast4);
    if (input.cardNetwork) recoveryUrl.searchParams.set("network", input.cardNetwork);
    if (input.cardType) recoveryUrl.searchParams.set("type", input.cardType);
    if (input.cardIssuer) recoveryUrl.searchParams.set("issuer", input.cardIssuer);
    if (input.vpa) recoveryUrl.searchParams.set("vpa", input.vpa);
    if (input.bankCode) recoveryUrl.searchParams.set("bank", input.bankCode);

    const outreachPayload: OutreachPayload = {
      proposalId: eventId,
      failureClass,
      action: decideOutput.chosen.action,
      recipient: {
        customerName: customer?.name ?? "Customer",
        phone: customer?.phone ?? "",
        email: customer?.email ?? "",
      },
      amountPaise: input.amountPaise,
      paymentLinkUrl: recoveryUrl.toString(),
      language: "EN",
      rawErrorReason: input.failureCode,
      instrumentDescription: input.failureDescription,
      customerMessage: getCustomerMessage(input.failureCode, input.failureDescription),
      vendorMessage: getVendorMessage(input.failureCode, input.failureDescription),
      // Payment method details for personalized outreach
      method: (["card", "upi", "netbanking", "wallet"].includes(input.paymentMethod || "") ? input.paymentMethod : undefined) as OutreachPayload["method"],
      last4: input.cardLast4 || "",
      network: input.cardNetwork || "",
      vpa: input.vpa || "",
      bank: input.bankCode || "",
    };

    logger.info({ msg: `Dispatching outreach for ${failureClass}`, failureClass, phone: outreachPayload.recipient.phone || '(none)', email: outreachPayload.recipient.email || '(none)' });

    // Dispatch Email via Brevo (skip if no email)
    if (outreachPayload.recipient.email) {
      try {
        const emailResult = await outreachRouter.dispatch("EMAIL", outreachPayload, nowMs);
        dispatchResults.push(emailResult);
        logger.info({ msg: `EMAIL → ${emailResult.status} via ${emailResult.providerName}`, channel: 'EMAIL', status: emailResult.status, provider: emailResult.providerName });
        // Store initial outreach result in scheduled_outreach for AI Action tracking
        // Distinguish simulated from real delivery
        const isSimulated = !!emailResult.errorMessage?.startsWith("SIMULATED:");
        const deliveryStatus = isSimulated ? "SENT_SIMULATED" : (emailResult.status.includes("SENT") ? "SENT" : "FAILED");
        try {
          await client.execute({
            sql: `INSERT OR IGNORE INTO scheduled_outreach
              (id, live_payment_event_id, customer_profile_id, channel, scheduled_at_utc, executed, executed_at_utc, status, error_message)
              VALUES (?, ?, ?, 'EMAIL', ?, 1, ?, ?, ?)`,
            args: [
              `init_${eventId}_EMAIL`, eventId, input.customerProfileId,
              nowUtc, nowUtc,
              deliveryStatus,
              emailResult.errorMessage || null,
            ],
          });
        } catch {}
      } catch (err) {
        logger.error({ msg: "Email dispatch failed", err: err as Error });
        // Store failed attempt
        try {
          await client.execute({
            sql: `INSERT OR IGNORE INTO scheduled_outreach
              (id, live_payment_event_id, customer_profile_id, channel, scheduled_at_utc, executed, executed_at_utc, status, error_message)
              VALUES (?, ?, ?, 'EMAIL', ?, 1, ?, 'FAILED', ?)`,
            args: [
              `init_${eventId}_EMAIL`, eventId, input.customerProfileId,
              nowUtc, nowUtc, (err as Error).message,
            ],
          });
        } catch {}
      }
    } else {
      logger.info({ msg: "SKIPPED email: no email address on customer profile" });
    }

    // Dispatch SMS via MSG91 (skip if no phone)
    if (outreachPayload.recipient.phone) {
      try {
        const smsResult = await outreachRouter.dispatch("SMS", outreachPayload, nowMs);
        dispatchResults.push(smsResult);
        logger.info({ msg: `SMS → ${smsResult.status} via ${smsResult.providerName}`, channel: 'SMS', status: smsResult.status, provider: smsResult.providerName });
        if (smsResult.status.includes("SUPPRESSED")) {
          logger.info({ msg: `SMS suppressed: ${smsResult.errorMessage}`, channel: 'SMS', reason: smsResult.errorMessage });
        }
        // Store initial outreach result in scheduled_outreach for AI Action tracking
        const isSmsSimulated = !!smsResult.errorMessage?.startsWith("SIMULATED:");
        const smsDeliveryStatus = isSmsSimulated ? "SENT_SIMULATED" : (smsResult.status.includes("SENT") ? "SENT" : (smsResult.status.includes("SUPPRESSED") ? "SUPPRESSED" : "FAILED"));
        try {
          await client.execute({
            sql: `INSERT OR IGNORE INTO scheduled_outreach
              (id, live_payment_event_id, customer_profile_id, channel, scheduled_at_utc, executed, executed_at_utc, status, error_message)
              VALUES (?, ?, ?, 'SMS', ?, 1, ?, ?, ?)`,
            args: [
              `init_${eventId}_SMS`, eventId, input.customerProfileId,
              nowUtc, nowUtc,
              smsDeliveryStatus,
              smsResult.errorMessage || null,
            ],
          });
        } catch {}
      } catch (err) {
        logger.error({ msg: "SMS dispatch failed", err: err as Error });
        // Store failed attempt
        try {
          await client.execute({
            sql: `INSERT OR IGNORE INTO scheduled_outreach
              (id, live_payment_event_id, customer_profile_id, channel, scheduled_at_utc, executed, executed_at_utc, status, error_message)
              VALUES (?, ?, ?, 'SMS', ?, 1, ?, 'FAILED', ?)`,
            args: [
              `init_${eventId}_SMS`, eventId, input.customerProfileId,
              nowUtc, nowUtc, (err as Error).message,
            ],
          });
        } catch {}
      }
    } else {
      logger.info({ msg: "SKIPPED SMS: no phone number on customer profile" });
    }

    // Schedule follow-ups
    const followUpChannels = [
      { channel: "SMS", delayMs: 2 * 60 * 60 * 1000 }, // +2 hours
      { channel: "EMAIL", delayMs: 24 * 60 * 60 * 1000 }, // +24 hours
      { channel: "SMS", delayMs: 48 * 60 * 60 * 1000 }, // +48 hours
      { channel: "EMAIL", delayMs: 72 * 60 * 60 * 1000 }, // +72 hours
    ];

    // Only schedule follow-ups if customer has contact info
    const hasContact = !!(outreachPayload.recipient.phone || outreachPayload.recipient.email);
    if (hasContact) {
      for (const fu of followUpChannels) {
        const scheduleId = `sch_${eventId}_${fu.channel}_${fu.delayMs}`;
        const scheduledAt = isoUtc(nowMs + fu.delayMs);
        await client.execute({
          sql: `INSERT OR IGNORE INTO scheduled_outreach
            (id, live_payment_event_id, customer_profile_id, channel, scheduled_at_utc)
            VALUES (?, ?, ?, ?, ?)`,
          args: [scheduleId, eventId, input.customerProfileId, fu.channel, scheduledAt],
        });
        scheduledOutreach.push({ channel: fu.channel, scheduledAtUtc: scheduledAt });
      }
    }

    // Mark outreach as dispatched only if messages were actually sent
    const anyDispatched = dispatchResults.some(r => r.status === "SENT" || r.status === "DELIVERED" || r.status === "QUEUED");
    if (anyDispatched) {
      await client.execute({
        sql: `UPDATE live_payment_events SET outreach_dispatched = 1 WHERE id = ?`,
        args: [eventId],
      });
    }
  }

  return {
    eventId,
    failureClass,
    probability,
    action: decideOutput.chosen.action,
    isSuspicious,
    suspicionReasons,
    credibilityScore: credResult.score,
    riskLevel: credResult.riskLevel,
    outreachDispatched: !isSuspicious && dispatchResults.length > 0,
    dispatchResults,
    scheduledOutreach,
  };
}

export async function recordSuccessfulPayment(
  client: Client,
  params: {
    razorpayPaymentId: string;
    razorpayOrderId: string;
    customerProfileId: string;
    amountPaise: number;
    productName: string;
    nowMs: number;
    paymentMethod?: string;
    cardLast4?: string;
    cardNetwork?: string;
    cardIssuer?: string;
    cardType?: string;
    vpa?: string;
    bankCode?: string;
  },
): Promise<string> {
  const nowUtc = isoUtc(params.nowMs);
  const eventId = `evt_${params.nowMs}_${createHash("sha256").update(`${params.razorpayPaymentId}${params.nowMs}`).digest("hex").slice(0, 8)}`;

  // Fetch customer profile for snapshot
  const custResult = await client.execute({
    sql: `SELECT name, phone, email FROM customer_profiles WHERE id = ?`,
    args: [params.customerProfileId],
  });
  const customer = custResult.rows[0] as any;

  // Step 7: If customer had a failed payment for this product, UPDATE it to 'captured'
  // (moves entry from failed view to successful view — no duplicate row)
  // Dedup key: customer + product (not order_id, since retry creates new orders)
  const existingFailed = await client.execute({
    sql: `SELECT id FROM live_payment_events
          WHERE customer_profile_id = ? AND product_name = ? AND status = 'failed'
          ORDER BY created_at_utc DESC LIMIT 1`,
    args: [params.customerProfileId, params.productName],
  });

  if (existingFailed.rows.length > 0) {
    const existingId = String(existingFailed.rows[0].id);
    await client.execute({
      sql: `UPDATE live_payment_events SET
        status = 'captured',
        razorpay_payment_id = ?,
        razorpay_order_id = ?,
        failure_code = NULL, failure_description = NULL, failure_class = NULL,
        ml_action = 'PAYMENT_RECEIVED',
        retry_count = 0,
        payment_method = COALESCE(?, payment_method),
        card_last4 = COALESCE(?, card_last4),
        card_network = COALESCE(?, card_network),
        card_issuer = COALESCE(?, card_issuer),
        card_type = COALESCE(?, card_type),
        vpa = COALESCE(?, vpa),
        bank_code = COALESCE(?, bank_code)
        WHERE id = ?`,
      args: [params.razorpayPaymentId, params.razorpayOrderId,
        params.paymentMethod || null, params.cardLast4 || null, params.cardNetwork || null,
        params.cardIssuer || null, params.cardType || null, params.vpa || null, params.bankCode || null,
        existingId],
    });
    logger.info({ msg: `Recovery: moved event ${existingId} from failed → captured for order ${params.razorpayOrderId}`, eventId: existingId, orderId: params.razorpayOrderId });

    // Update customer profile
    await client.execute({
      sql: `UPDATE customer_profiles SET
        total_attempts = total_attempts + 1,
        total_successes = total_successes + 1,
        total_amount_paise = total_amount_paise + ?
        WHERE id = ?`,
      args: [params.amountPaise, params.customerProfileId],
    });

    // Cancel pending outreach for this event
    await client.execute({
      sql: `UPDATE scheduled_outreach SET executed = 1, status = 'SUPPRESSED', executed_at_utc = ?
        WHERE live_payment_event_id = ? AND executed = 0`,
      args: [nowUtc, existingId],
    });

    return existingId;
  }

  // No prior failed row: INSERT new successful row
  await client.execute({
    sql: `INSERT INTO live_payment_events
      (id, razorpay_payment_id, razorpay_order_id, customer_profile_id, product_name, amount_paise, status, created_at_utc,
       payment_method, card_last4, card_network, card_issuer, card_type, vpa, bank_code,
       customer_name, customer_phone, customer_email)
      VALUES (?, ?, ?, ?, ?, ?, 'captured', ?,
              ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?)`,
    args: [
      eventId,
      params.razorpayPaymentId,
      params.razorpayOrderId,
      params.customerProfileId,
      params.productName,
      params.amountPaise,
      nowUtc,
      params.paymentMethod || null,
      params.cardLast4 || null,
      params.cardNetwork || null,
      params.cardIssuer || null,
      params.cardType || null,
      params.vpa || null,
      params.bankCode || null,
      customer?.name || null,
      customer?.phone || null,
      customer?.email || null,
    ],
  });

  await client.execute({
    sql: `UPDATE customer_profiles SET
      total_attempts = total_attempts + 1,
      total_successes = total_successes + 1,
      total_amount_paise = total_amount_paise + ?
      WHERE id = ?`,
    args: [params.amountPaise, params.customerProfileId],
  });

  // Cancel pending outreach
  await client.execute({
    sql: `UPDATE scheduled_outreach SET executed = 1, status = 'SUPPRESSED', executed_at_utc = ?
      WHERE live_payment_event_id = ? AND executed = 0`,
    args: [nowUtc, eventId],
  });

  return eventId;
}
