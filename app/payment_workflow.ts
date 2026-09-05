/**
 * Real Payment Workflow — processes failed Razorpay payments through the full pipeline:
 * webhook → error extraction → failure classification → ML scoring → EV decision → outreach dispatch.
 *
 * Replaces simulateFailureTriage with a real, production-grade pipeline.
 */
import type { Client } from "@libsql/client";
import { createHash } from "node:crypto";
import { isoUtc, paise, formatINR, logger, getPublicBaseUrl, getMerchantVpa } from "../packages/shared/src/index.js";
import { classifyByCode, computeFeatures, scoreWithArtifact, DEFAULT_22D_MODEL, DEFAULT_16D_MODEL, getActiveModel, assessCredibility } from "../packages/ml/src/index.js";
import {
  decide,
  defaultPolicy,
  type DecideOutput,
  type FailureClassId,
  appendAuditLedger,
  diagnosePaymentFailure,
  LinUCBBandit,
  defaultEnterpriseBandit,
  type EnterpriseBanditAction,
  type ArmSelectionResult,
  recordMetricsDelta,
  getMethodDelta,
  createRazorpayNativePaymentLink,
} from "../packages/core/src/index.js";
import { OutreachRouter, type OutreachChannel, type OutreachPayload, type ProviderDispatchResult } from "../packages/core/src/messaging/index.js";
import { getErrorEntry, getCustomerMessage, getVendorMessage, getFailureClass as getCatalogFailureClass } from "../packages/core/src/error-catalog.js";
import { getGroqCustomerMessage } from "../packages/core/src/messaging/groq_customer_message.js";

export interface Product {
  id: string;
  name: string;
  description: string;
  pricePaise: number;
  image: string;
}

export const PRODUCTS: Product[] = [
  // ── D2C Products ──
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
  // ── SaaS Mandates (UPI Autopay / eNACH) ──
  {
    id: "mandate_cloud_pro",
    name: "Cloud Infrastructure Pro",
    description: "Monthly recurring UPI Autopay subscription for cloud infrastructure",
    pricePaise: 299900,
    image: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect fill='%230369a1' width='200' height='200'/%3E%3Ctext fill='%23ffffff' x='100' y='90' text-anchor='middle' font-size='40' font-family='Arial'%3E⚡%3C/text%3E%3Ctext fill='%23bae6fd' x='100' y='120' text-anchor='middle' font-size='14' font-family='Arial'%3ECloud Pro%3C/text%3E%3C/svg%3E",
  },
  {
    id: "mandate_saas_annual",
    name: "SaaS Enterprise Mandate",
    description: "Annual eNACH recurring mandate with multi-attempt grace period",
    pricePaise: 1299900,
    image: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect fill='%2315803d' width='200' height='200'/%3E%3Ctext fill='%23ffffff' x='100' y='90' text-anchor='middle' font-size='40' font-family='Arial'%3E🛡️%3C/text%3E%3Ctext fill='%23bbf7d0' x='100' y='120' text-anchor='middle' font-size='14' font-family='Arial'%3ESaaS Mandate%3C/text%3E%3C/svg%3E",
  },
  {
    id: "mandate_starter",
    name: "Micro-SaaS Starter Mandate",
    description: "Fixed monthly subscription mandate with automated bank switch routing",
    pricePaise: 49900,
    image: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect fill='%23b45309' width='200' height='200'/%3E%3Ctext fill='%23ffffff' x='100' y='90' text-anchor='middle' font-size='40' font-family='Arial'%3E✨%3C/text%3E%3Ctext fill='%23fde68a' x='100' y='120' text-anchor='middle' font-size='14' font-family='Arial'%3EStarter%3C/text%3E%3C/svg%3E",
  },
  // ── B2B Invoices (2/10 Net 30 Terms) ──
  {
    id: "inv_software_retainer",
    name: "Enterprise Software Retainer",
    description: "Net 30 invoice offering 2% instant cash discount if paid within 10 days",
    pricePaise: 15000000,
    image: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect fill='%234338ca' width='200' height='200'/%3E%3Ctext fill='%23ffffff' x='100' y='90' text-anchor='middle' font-size='40' font-family='Arial'%3E📜%3C/text%3E%3Ctext fill='%23c7d2fe' x='100' y='120' text-anchor='middle' font-size='14' font-family='Arial'%3ERetainer%3C/text%3E%3C/svg%3E",
  },
  {
    id: "inv_infra_sla",
    name: "Dedicated Cloud SLA Invoice",
    description: "High-ticket corporate invoice saving 2% on early settlement terms",
    pricePaise: 42500000,
    image: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect fill='%237c2d12' width='200' height='200'/%3E%3Ctext fill='%23ffffff' x='100' y='90' text-anchor='middle' font-size='40' font-family='Arial'%3E🏛️%3C/text%3E%3Ctext fill='%23fed7aa' x='100' y='120' text-anchor='middle' font-size='14' font-family='Arial'%3ESLA Invoice%3C/text%3E%3C/svg%3E",
  },
  {
    id: "inv_api_usage",
    name: "Monthly API Volume Invoicing",
    description: "Corporate receivable with automated SMS/Email finance chaser",
    pricePaise: 8500000,
    image: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect fill='%23047857' width='200' height='200'/%3E%3Ctext fill='%23ffffff' x='100' y='90' text-anchor='middle' font-size='40' font-family='Arial'%3E📈%3C/text%3E%3Ctext fill='%23a7f3d0' x='100' y='120' text-anchor='middle' font-size='14' font-family='Arial'%3EUsage Invoice%3C/text%3E%3C/svg%3E",
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
  acquirerErrorCode?: string; // Acquirer response error code (ISO-8583/NPCI)

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
  credibilityScore?: number;
  riskLevel?: string;
  outreachDispatched: boolean;
  dispatchResults: ProviderDispatchResult[];
  scheduledOutreach: Array<{ channel: string; scheduledAtUtc: string }>;
  banditSelection?: ArmSelectionResult<EnterpriseBanditAction>;
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
      // Derive paydayPattern from customer profile's inferred_payday_day and payday_confidence_bp
      paydayPattern: customer?.inferred_payday_day
        ? { [String(customer.inferred_payday_day)]: Math.max(1, Math.round((customer.payday_confidence_bp ?? 5000) / 1000)) }
        : null,
    },
    // Payment method features (from Razorpay webhook)
    paymentMethod: input.paymentMethod,
    cardType: input.cardType,
    cardEmi: input.cardEmi,
    isInternational: input.isInternational,
  });

  // 4. Score with ML model
  const scoreResult = scoreWithArtifact(features.values, getActiveModel());
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

  // 6b. LinUCB Enterprise Bandit Context & Dynamic Arm Selection
  const dwellTimeSeconds = 0;
  const openLatencyMins = Number((customer as any)?.email_open_latency_mins ?? 30);
  const priorFailureCount = Number(customer?.total_failures ?? 0);
  const channelResp = (customer?.total_attempts ?? 0) > 0
    ? Number((customer?.total_successes ?? 0) / customer!.total_attempts)
    : Number((customer as any)?.channel_responsiveness ?? 0.5);

  const banditContext = LinUCBBandit.buildEnterpriseContext(
    input.amountPaise,
    dwellTimeSeconds,
    openLatencyMins,
    priorFailureCount,
    channelResp
  );
  const banditSelection = defaultEnterpriseBandit.selectArm(banditContext);

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
          bandit_action = ?, bandit_context_json = ?, bandit_ucb_score = ?,
          payment_method = ?, card_last4 = ?, card_network = ?, card_issuer = ?, card_type = ?,
          vpa = ?, bank_code = ?,
          retry_count = ?,
          created_at_utc = ?
          WHERE id = ?`,
        args: [
          input.razorpayPaymentId, input.razorpayOrderId,
          input.failureCode, input.failureDescription, input.failureStep, input.failureSource, input.failureReason,
          failureClass, probability, decideOutput.chosen.action,
          banditSelection.action, JSON.stringify(banditSelection.context), banditSelection.ucbScore,
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
        banditSelection,
      };
    }
    // isNewOrder=true: fall through to INSERT below (new independent transaction)
    logger.info({ msg: `New retry order ${input.razorpayOrderId}: creating new transaction (original was ${existingRow.rows[0].id})`, orderId: input.razorpayOrderId, originalEventId: existingRow.rows[0].id });
  }

  // FIRST ATTEMPT / NEW RETRY ORDER: Insert new row
  try {
    await client.execute({
      sql: `INSERT INTO live_payment_events
        (id, razorpay_payment_id, razorpay_order_id, customer_profile_id, product_name, amount_paise,
         status, failure_code, failure_description, failure_step, failure_source, failure_reason,
         failure_class, ml_probability, ml_action, bandit_action, bandit_context_json, bandit_ucb_score,
         outreach_dispatched, vendor_notified, created_at_utc,
         payment_method, card_last4, card_network, card_issuer, card_type, card_emi,
         vpa, bank_code, is_international,
         acquirer_auth_code, acquirer_rrn, acquirer_error_code,
         razorpay_token_id, razorpay_contact, razorpay_email, razorpay_created_at,
         customer_name, customer_phone, customer_email)
        VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?,
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
        banditSelection.action,
        JSON.stringify(banditSelection.context),
        banditSelection.ucbScore,
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
        input.acquirerErrorCode || null,
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

  // Update vendor metrics summary atomically
  await recordMetricsDelta(client, {
    totalEvents: 1,
    totalFailures: 1,
    atRiskPaise: input.amountPaise,
    ...getMethodDelta(input.paymentMethod),
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

  // 8b. Append tamper-evident audit ledger entries for detection, diagnosis, and policy
  try {
    await appendAuditLedger(client, {
      eventType: "EVENT_DETECTED",
      entityId: eventId,
      customerId: input.customerProfileId,
      payload: {
        paymentId: input.razorpayPaymentId,
        orderId: input.razorpayOrderId,
        amountPaise: input.amountPaise,
        productName: input.productName,
        method: input.paymentMethod || "unknown",
      },
      nowMs,
    });
    const auditDiag = diagnosePaymentFailure({
      failureCode: input.failureCode,
      failureDescription: input.failureDescription,
      failureStep: input.failureStep,
      failureSource: input.failureSource,
      failureReason: input.failureReason,
      paymentMethod: input.paymentMethod,
      cardLast4: input.cardLast4,
      cardNetwork: input.cardNetwork,
      cardIssuer: input.cardIssuer,
      bankCode: input.bankCode,
      vpa: input.vpa,
      acquirerErrorCode: input.acquirerErrorCode,
      acquirerRrn: input.acquirerRrn,
    });
    await appendAuditLedger(client, {
      eventType: "DIAGNOSED",
      entityId: eventId,
      customerId: input.customerProfileId,
      payload: {
        code: input.failureCode,
        failureClass,
        step: input.failureStep,
        isSuspicious,
        credibilityScore: credResult.score,
        faultDomain: auditDiag.faultDomain,
        isoCode: auditDiag.isoCode,
      },
      nowMs,
    });
    await appendAuditLedger(client, {
      eventType: "POLICY_EVALUATED",
      entityId: eventId,
      customerId: input.customerProfileId,
      payload: {
        action: decideOutput.chosen.action,
        probability,
        expectedValuePaise: decideOutput.chosen.expectedValuePaise,
        traiQuietHours: "PASS",
        dndCheck: "PASS",
      },
      nowMs,
    });
    await appendAuditLedger(client, {
      eventType: "BANDIT_ARM_SELECTED",
      entityId: eventId,
      customerId: input.customerProfileId,
      payload: {
        action: banditSelection.action,
        estimatedReward: banditSelection.estimatedReward,
        confidenceBound: banditSelection.confidenceBound,
        ucbScore: banditSelection.ucbScore,
        context: banditSelection.context,
      },
      nowMs,
    });
  } catch {}

  // 9. Dispatch outreach if not suspicious
  const dispatchResults: ProviderDispatchResult[] = [];
  const scheduledOutreach: Array<{ channel: string; scheduledAtUtc: string }> = [];

  if (!isSuspicious) {
    // Immediate outreach via primary channels (Email + SMS only, no WhatsApp/Voice)
    // Build recovery URL with product info so customer's cart is restored
    const baseUrl = getPublicBaseUrl();
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
    // GROQ-polished customer message for transaction-specific heading (no PII sent to GROQ)
    const groqCustomerMessage = await getGroqCustomerMessage(input.failureCode, input.failureDescription, {
      context: {
        amountPaise: input.amountPaise,
        productName: input.productName,
        paymentMethod: input.paymentMethod,
        cardIssuer: input.cardIssuer,
        cardLast4: input.cardLast4,
        bankCode: input.bankCode,
        vpa: input.vpa,
      },
    });
    recoveryUrl.searchParams.set("class", failureClass);
    recoveryUrl.searchParams.set("code", input.failureCode);
    recoveryUrl.searchParams.set("reason", groqCustomerMessage);

    // Include payment method details in URL so recovery page can display them
    if (input.paymentMethod) recoveryUrl.searchParams.set("method", input.paymentMethod);
    if (input.cardLast4) recoveryUrl.searchParams.set("last4", input.cardLast4);
    if (input.cardNetwork) recoveryUrl.searchParams.set("network", input.cardNetwork);
    if (input.cardType) recoveryUrl.searchParams.set("type", input.cardType);
    if (input.cardIssuer) recoveryUrl.searchParams.set("issuer", input.cardIssuer);
    if (input.vpa) recoveryUrl.searchParams.set("vpa", input.vpa);
    if (input.bankCode) recoveryUrl.searchParams.set("bank", input.bankCode);

    // FIX-016: Generate native Razorpay Payment Link (https://rzp.io/i/...) when credentials active
    let effectivePaymentLink = recoveryUrl.toString();
    try {
      const nativeLink = await createRazorpayNativePaymentLink({
        amountPaise: input.amountPaise,
        description: `Order recovery retry for ${input.productName || "Purchase"}`,
        customer: customer ? { name: customer.name, phone: customer.phone, email: customer.email } : undefined,
        callbackUrl: recoveryUrl.toString(),
        notes: { event_id: eventId, failure_class: failureClass },
        idempotencyKey: `pl_link_${eventId}`,
      });
      if (nativeLink?.short_url) {
        effectivePaymentLink = nativeLink.short_url;
        logger.info({ msg: "[PaymentWorkflow] Created native Razorpay Payment Link", url: effectivePaymentLink, eventId });
      }
    } catch {}

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
      paymentLinkUrl: effectivePaymentLink,
      language: "EN",
      rawErrorReason: input.failureCode,
      instrumentDescription: input.failureDescription,
      customerMessage: groqCustomerMessage,
      vendorMessage: getVendorMessage(input.failureCode, input.failureDescription),
      // Payment method details for personalized outreach
      method: (["card", "upi", "netbanking", "wallet"].includes(input.paymentMethod || "") ? input.paymentMethod : undefined) as OutreachPayload["method"],
      last4: input.cardLast4 || "",
      network: input.cardNetwork || "",
      vpa: input.vpa || "",
      bank: input.bankCode || "",
    };

    logger.info({
      msg: `Dispatching arm-governed outreach for ${failureClass}`,
      failureClass,
      banditAction: banditSelection.action,
      phone: outreachPayload.recipient.phone || '(none)',
      email: outreachPayload.recipient.email || '(none)'
    });

    const chosenAction = banditSelection.action;
    const hasPhone = !!outreachPayload.recipient.phone;
    const hasEmail = !!outreachPayload.recipient.email;

    // Strict Bandit-Governed Primary Channel Execution
    const isSmsPrimary = chosenAction === "SMS_1TAP_UPI" || chosenAction === "SPLIT_PAY_3X" || chosenAction === "IN_FLIGHT_CASCADE";
    const isEmailPrimary = chosenAction === "EMAIL_1TAP_UPI" || chosenAction === "DOWNSELL_OFFER";

    // 1. Execute Primary Bandit Action
    if (isSmsPrimary && hasPhone) {
      try {
        const smsResult = await outreachRouter.dispatchWithCascade("SMS", outreachPayload, nowMs);
        dispatchResults.push(smsResult);
        logger.info({ msg: `BANDIT PRIMARY DISPATCH SMS → ${smsResult.status} via ${smsResult.providerName}`, channel: smsResult.channel, status: smsResult.status, provider: smsResult.providerName, banditAction: chosenAction });

        const isSmsSimulated = !!smsResult.errorMessage?.startsWith("SIMULATED:");
        const smsDeliveryStatus = isSmsSimulated ? "SENT_SIMULATED" : (smsResult.status.includes("SENT") ? "SENT" : (smsResult.status.includes("SUPPRESSED") ? "SUPPRESSED" : "FAILED"));
        try {
          await client.execute({
            sql: `INSERT OR IGNORE INTO scheduled_outreach
              (id, live_payment_event_id, customer_profile_id, channel, scheduled_at_utc, executed, executed_at_utc, status, error_message)
              VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
            args: [
              `init_${eventId}_${smsResult.channel}`, eventId, input.customerProfileId,
              smsResult.channel,
              nowUtc, nowUtc,
              smsDeliveryStatus,
              smsResult.errorMessage || null,
            ],
          });
        } catch {}
      } catch (err) {
        logger.error({ msg: "Bandit primary SMS dispatch failed", err: err as Error });
      }
    } else if (isEmailPrimary && hasEmail) {
      try {
        const emailResult = await outreachRouter.dispatch("EMAIL", outreachPayload, nowMs);
        dispatchResults.push(emailResult);
        logger.info({ msg: `BANDIT PRIMARY DISPATCH EMAIL → ${emailResult.status} via ${emailResult.providerName}`, channel: 'EMAIL', status: emailResult.status, provider: emailResult.providerName, banditAction: chosenAction });

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
        logger.error({ msg: "Bandit primary Email dispatch failed", err: err as Error });
      }
    }

    // 2. Multi-Channel Enterprise Escalation / Fallback Dispatch
    // If Email was not dispatched as primary but is available on profile, dispatch Email confirmation
    if (hasEmail && !dispatchResults.some(r => r.channel === "EMAIL")) {
      try {
        const emailResult = await outreachRouter.dispatch("EMAIL", outreachPayload, nowMs);
        dispatchResults.push(emailResult);
        logger.info({ msg: `EMAIL NOTIFICATION → ${emailResult.status} via ${emailResult.providerName}`, channel: 'EMAIL', status: emailResult.status, provider: emailResult.providerName });

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
        logger.error({ msg: "Email notification dispatch failed", err: err as Error });
      }
    }

    // If SMS was not dispatched as primary but phone is available and email is missing, dispatch SMS
    if (hasPhone && dispatchResults.length === 0) {
      try {
        const smsResult = await outreachRouter.dispatchWithCascade("SMS", outreachPayload, nowMs);
        dispatchResults.push(smsResult);
        const isSmsSimulated = !!smsResult.errorMessage?.startsWith("SIMULATED:");
        const smsDeliveryStatus = isSmsSimulated ? "SENT_SIMULATED" : (smsResult.status.includes("SENT") ? "SENT" : (smsResult.status.includes("SUPPRESSED") ? "SUPPRESSED" : "FAILED"));
        try {
          await client.execute({
            sql: `INSERT OR IGNORE INTO scheduled_outreach
              (id, live_payment_event_id, customer_profile_id, channel, scheduled_at_utc, executed, executed_at_utc, status, error_message)
              VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
            args: [
              `init_${eventId}_${smsResult.channel}`, eventId, input.customerProfileId,
              smsResult.channel,
              nowUtc, nowUtc,
              smsDeliveryStatus,
              smsResult.errorMessage || null,
            ],
          });
        } catch {}
      } catch (err) {
        logger.error({ msg: "Fallback SMS dispatch failed", err: err as Error });
      }
    }

    // Schedule follow-ups dynamically based on user engagement history
    const openLatency = customer?.email_open_latency_mins ?? null;
    const isRapidResponder = openLatency !== null && openLatency <= 30;
    const followUpChannels = isRapidResponder
      ? [
          { channel: "EMAIL", delayMs: 30 * 60 * 1000 },       // +30m rapid follow-up
          { channel: "SMS", delayMs: 2 * 60 * 60 * 1000 },      // +2 hours
          { channel: "EMAIL", delayMs: 24 * 60 * 60 * 1000 },   // +24 hours
        ]
      : [
          { channel: "SMS", delayMs: 2 * 60 * 60 * 1000 },      // +2 hours
          { channel: "EMAIL", delayMs: 24 * 60 * 60 * 1000 },   // +24 hours
          { channel: "SMS", delayMs: 48 * 60 * 60 * 1000 },     // +48 hours
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
    const anyDispatched = dispatchResults.some(r => r.status === "SENT" || r.status === "DELIVERED" || r.status === "QUEUED" || r.status === "SENT_SIMULATED");
    if (anyDispatched) {
      await client.execute({
        sql: `UPDATE live_payment_events SET outreach_dispatched = 1 WHERE id = ?`,
        args: [eventId],
      });
      try {
        await appendAuditLedger(client, {
          eventType: "OUTREACH_DISPATCHED",
          entityId: eventId,
          customerId: input.customerProfileId,
          payload: {
            channels: dispatchResults.map(r => r.channel),
            customerMessage: groqCustomerMessage,
            recoveryUrl: recoveryUrl.toString(),
          },
          nowMs,
        });
      } catch {}
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
    banditSelection,
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

  let existingFailed;
  try {
    existingFailed = await client.execute({
      sql: `SELECT id, bandit_action, bandit_context_json FROM live_payment_events
            WHERE (customer_profile_id = ? OR razorpay_order_id = ?) AND status = 'failed'
            ORDER BY created_at_utc DESC LIMIT 1`,
      args: [params.customerProfileId, params.razorpayOrderId],
    });
  } catch (err: any) {
    if (err?.message?.includes("bandit_action")) {
      existingFailed = await client.execute({
        sql: `SELECT id FROM live_payment_events
              WHERE (customer_profile_id = ? OR razorpay_order_id = ?) AND status = 'failed'
              ORDER BY created_at_utc DESC LIMIT 1`,
        args: [params.customerProfileId, params.razorpayOrderId],
      });
    } else {
      throw err;
    }
  }

  if (existingFailed.rows.length > 0) {
    const existingId = String(existingFailed.rows[0].id);
    const banditAction = existingFailed.rows[0].bandit_action ? String(existingFailed.rows[0].bandit_action) : null;
    const banditContextJson = existingFailed.rows[0].bandit_context_json ? String(existingFailed.rows[0].bandit_context_json) : null;

    // Closed-loop online RL feedback: update bandit arm with r=1.0 and persist
    if (banditAction && banditContextJson) {
      try {
        const context = JSON.parse(banditContextJson) as number[];
        if (Array.isArray(context)) {
          defaultEnterpriseBandit.updateArm(banditAction as any, context, 1.0);
          await defaultEnterpriseBandit.saveArmToDb(client, "enterprise", banditAction as any);
          await appendAuditLedger(client, {
            eventType: "BANDIT_REWARD_FEEDBACK",
            entityId: existingId,
            customerId: params.customerProfileId,
            actor: "payment_workflow",
            nowMs: params.nowMs,
            payload: {
              armType: "enterprise",
              action: banditAction,
              reward: 1.0,
              orderId: params.razorpayOrderId,
              paymentId: params.razorpayPaymentId,
            },
          });
          logger.info({
            msg: `[Bandit] Online reward (+1.0) applied to arm ${banditAction} for event ${existingId}`,
            action: banditAction,
            eventId: existingId,
          });
        }
      } catch (banditErr) {
        logger.error({ msg: "[Bandit] Failed to update bandit reward in recordSuccessfulPayment", err: banditErr });
      }
    }
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

    // Update vendor metrics summary atomically (moved from failure to captured)
    await recordMetricsDelta(client, {
      totalFailures: -1,
      totalSuccesses: 1,
      atRiskPaise: -params.amountPaise,
      recoveredPaise: params.amountPaise,
    });

    // Update customer profile
    await client.execute({
      sql: `UPDATE customer_profiles SET
        total_attempts = total_attempts + 1,
        total_successes = total_successes + 1,
        total_amount_paise = total_amount_paise + ?
        WHERE id = ?`,
      args: [params.amountPaise, params.customerProfileId],
    });

    // Increment total_recovered_paise and alternate_account_converted if columns exist (migration 0022)
    try {
      await client.execute({
        sql: `UPDATE customer_profiles SET total_recovered_paise = total_recovered_paise + ?, alternate_account_converted = 1 WHERE id = ?`,
        args: [params.amountPaise, params.customerProfileId],
      });
    } catch {
      try {
        await client.execute({
          sql: `UPDATE customer_profiles SET alternate_account_converted = 1 WHERE id = ?`,
          args: [params.customerProfileId],
        });
      } catch {}
    }

    // Cancel pending outreach for this event (mark CANCELLED with audit reason)
    await client.execute({
      sql: `UPDATE scheduled_outreach SET executed = 1, status = 'CANCELLED', cancelled_reason = 'PAYMENT_COMPLETED',
            cancelled_at_utc = ?, executed_at_utc = ?
            WHERE live_payment_event_id = ? AND (executed = 0 OR status = 'PENDING')`,
      args: [nowUtc, nowUtc, existingId],
    });

    try {
      await appendAuditLedger(client, {
        eventType: "PAYMENT_RECOVERED",
        entityId: params.razorpayOrderId || existingId,
        customerId: params.customerProfileId,
        actor: "razorpay_gateway",
        nowMs: params.nowMs,
        payload: {
          eventId: existingId,
          orderId: params.razorpayOrderId,
          paymentId: params.razorpayPaymentId,
          amountPaise: params.amountPaise,
          method: params.paymentMethod,
        },
      });
    } catch {}

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

  // Update vendor metrics summary atomically
  await recordMetricsDelta(client, {
    totalEvents: 1,
    totalSuccesses: 1,
    recoveredPaise: params.amountPaise,
    ...getMethodDelta(params.paymentMethod),
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
    sql: `UPDATE scheduled_outreach SET executed = 1, status = 'CANCELLED', cancelled_reason = 'PAYMENT_COMPLETED',
          cancelled_at_utc = ?, executed_at_utc = ?
          WHERE live_payment_event_id = ? AND (executed = 0 OR status = 'PENDING')`,
    args: [nowUtc, nowUtc, eventId],
  });

  try {
    await appendAuditLedger(client, {
      eventType: "PAYMENT_CAPTURED",
      entityId: params.razorpayOrderId || eventId,
      customerId: params.customerProfileId,
      actor: "razorpay_gateway",
      nowMs: params.nowMs,
      payload: {
        eventId,
        orderId: params.razorpayOrderId,
        paymentId: params.razorpayPaymentId,
        amountPaise: params.amountPaise,
      },
    });
  } catch {}

  return eventId;
}

/**
 * Executes post-payment recovery workflow:
 * 1. Marks live payment event as captured / recovered.
 * 2. Marks any associated payment_intents as SUCCEEDED.
 * 3. Fulfills pending live_promise_to_pay.
 * 4. Cancels all pending/scheduled dunning messages.
 * 5. Appends immutable SHA-256 cryptographic audit ledger entry.
 */
export async function onPaymentRecovered(
  client: Client,
  params: {
    customerProfileId: string;
    orderId: string;
    eventId?: string;
    amountPaise?: number;
    paymentMethod?: string;
    nowMs?: number;
  },
): Promise<{
  recovered: boolean;
  cancelledOutreachCount: number;
  auditEntryId: string;
}> {
  const nowMs = params.nowMs ?? Date.now();
  const nowUtc = isoUtc(nowMs);

  // 1. Mark live payment event as captured / recovered
  let targetEventId = params.eventId;
  if (!targetEventId && params.orderId) {
    const ev = await client.execute({
      sql: `SELECT id FROM live_payment_events WHERE razorpay_order_id = ? OR customer_profile_id = ? ORDER BY created_at_utc DESC LIMIT 1`,
      args: [params.orderId, params.customerProfileId],
    });
    if (ev.rows.length > 0) {
      targetEventId = String(ev.rows[0].id);
    }
  }

  if (targetEventId) {
    try {
      const banditRow = await client.execute({
        sql: `SELECT bandit_action, bandit_context_json, status, amount_paise FROM live_payment_events WHERE id = ?`,
        args: [targetEventId],
      });
      if (banditRow.rows.length > 0) {
        const bAction = banditRow.rows[0].bandit_action ? String(banditRow.rows[0].bandit_action) : null;
        const bContextJson = banditRow.rows[0].bandit_context_json ? String(banditRow.rows[0].bandit_context_json) : null;
        const prevStatus = String(banditRow.rows[0].status);
        if (prevStatus !== "captured") {
          const recAmount = Number(banditRow.rows[0].amount_paise || 0);
          await recordMetricsDelta(client, {
            totalFailures: -1,
            totalSuccesses: 1,
            atRiskPaise: -recAmount,
            recoveredPaise: recAmount,
          });
        }
        if (bAction && bContextJson && prevStatus !== "captured") {
          const context = JSON.parse(bContextJson) as number[];
          if (Array.isArray(context)) {
            defaultEnterpriseBandit.updateArm(bAction as any, context, 1.0);
            await defaultEnterpriseBandit.saveArmToDb(client, "enterprise", bAction as any);
            await appendAuditLedger(client, {
              eventType: "BANDIT_REWARD_FEEDBACK",
              entityId: targetEventId,
              customerId: params.customerProfileId,
              actor: "customer_portal",
              nowMs,
              payload: {
                armType: "enterprise",
                action: bAction,
                reward: 1.0,
                orderId: params.orderId,
              },
            });
            logger.info({
              msg: `[Bandit] Online reward (+1.0) applied to arm ${bAction} via onPaymentRecovered for event ${targetEventId}`,
              action: bAction,
              eventId: targetEventId,
            });
          }
        }
      }
    } catch (banditErr) {
      logger.error({ msg: "[Bandit] Error updating bandit reward in onPaymentRecovered", err: banditErr });
    }

    // 2. Atomic multi-statement batch update for settlement integrity (FIX-025)
    let cancelledOutreachCount = 0;
    try {
      const countRes = await client.execute({
        sql: `SELECT count(*) as count FROM scheduled_outreach
              WHERE (customer_profile_id = ? OR live_payment_event_id = ?) AND (executed = 0 OR status = 'PENDING')`,
        args: [params.customerProfileId, targetEventId || ""],
      });
      cancelledOutreachCount = Number(countRes.rows[0]?.count ?? 0);
    } catch {}

    try {
      await client.batch([
        {
          sql: `UPDATE live_payment_events
                SET status = 'captured', recovered_at_utc = ?, ml_action = 'PAYMENT_RECOVERED'
                WHERE id = ?`,
          args: [nowUtc, targetEventId],
        },
        {
          sql: `UPDATE payment_intents SET status = 'SUCCEEDED', resolved_at_utc = ? WHERE order_id = ? OR customer_id = ?`,
          args: [nowUtc, params.orderId, params.customerProfileId],
        },
        {
          sql: `UPDATE scheduled_outreach
                SET executed = 1, status = 'CANCELLED', cancelled_reason = 'PAYMENT_COMPLETED',
                    cancelled_at_utc = ?, executed_at_utc = ?
                WHERE (customer_profile_id = ? OR live_payment_event_id = ?) AND (executed = 0 OR status = 'PENDING')`,
          args: [nowUtc, nowUtc, params.customerProfileId, targetEventId || ""],
        },
      ], "write");
    } catch {
      await client.execute({
        sql: `UPDATE live_payment_events
              SET status = 'captured', recovered_at_utc = ?, ml_action = 'PAYMENT_RECOVERED'
              WHERE id = ?`,
        args: [nowUtc, targetEventId],
      });
      try {
        await client.execute({
          sql: `UPDATE payment_intents SET status = 'SUCCEEDED', resolved_at_utc = ? WHERE order_id = ? OR customer_id = ?`,
          args: [nowUtc, params.orderId, params.customerProfileId],
        });
      } catch {}
      await client.execute({
        sql: `UPDATE scheduled_outreach
              SET executed = 1, status = 'CANCELLED', cancelled_reason = 'PAYMENT_COMPLETED',
                  cancelled_at_utc = ?, executed_at_utc = ?
              WHERE (customer_profile_id = ? OR live_payment_event_id = ?) AND (executed = 0 OR status = 'PENDING')`,
        args: [nowUtc, nowUtc, params.customerProfileId, targetEventId || ""],
      });
    }
  }

  let finalCancelledCount = 0;
  try {
    const checkRes = await client.execute({
      sql: `SELECT count(*) as count FROM scheduled_outreach
            WHERE (customer_profile_id = ? OR live_payment_event_id = ?) AND status = 'CANCELLED' AND cancelled_reason = 'PAYMENT_COMPLETED'`,
      args: [params.customerProfileId, targetEventId || ""],
    });
    finalCancelledCount = Number(checkRes.rows[0]?.count ?? 0);
  } catch {}
  const cancelledOutreachCount = finalCancelledCount;

  // 5. Append immutable cryptographic SHA-256 audit ledger entry
  const audit = await appendAuditLedger(client, {
    eventType: "RECOVERY_COMPLETED",
    entityId: params.orderId || targetEventId || `recovery_${nowMs}`,
    customerId: params.customerProfileId,
    actor: "customer_portal",
    nowMs,
    payload: {
      orderId: params.orderId,
      eventId: targetEventId,
      amountPaise: params.amountPaise,
      paymentMethod: params.paymentMethod,
      cancelledOutreachCount,
    },
  });

  logger.info({
    msg: `[onPaymentRecovered] Pruned ${cancelledOutreachCount} pending reminders for customer ${params.customerProfileId}`,
    orderId: params.orderId,
    auditEntryId: audit.id,
    auditHash: audit.entryHash,
  });

  return {
    recovered: true,
    cancelledOutreachCount,
    auditEntryId: audit.id,
  };
}

/**
 * Generates mobile-optimized 1-Tap UPI Intent URI deep links conforming to NPCI standards.
 */
export function generateUpiIntents(params: {
  amountPaise: number;
  merchantVpa?: string;
  merchantName?: string;
  transactionRef: string;
  transactionNote?: string;
}): {
  rawUpiUri: string;
  gpayUri: string;
  phonepeUri: string;
  paytmUri: string;
  bhimUri: string;
  amountRupees: string;
} {
  const amountRupees = (params.amountPaise / 100).toFixed(2);
  const vpa = getMerchantVpa(params.merchantVpa);
  const name = encodeURIComponent(params.merchantName || "ARBITER");
  const note = encodeURIComponent(params.transactionNote || `Payment_Recovery_${params.transactionRef}`);
  const ref = encodeURIComponent(params.transactionRef);

  const rawUpiUri = `upi://pay?pa=${vpa}&pn=${name}&am=${amountRupees}&cu=INR&tn=${note}&tr=${ref}`;
  const gpayUri = `upi://pay?pa=${vpa}&pn=${name}&am=${amountRupees}&cu=INR&tn=${note}&tr=${ref}&package=com.google.android.apps.nbu.paisa.user`;
  const phonepeUri = `phonepe://pay?pa=${vpa}&pn=${name}&am=${amountRupees}&cu=INR&tn=${note}&tr=${ref}`;
  const paytmUri = `paytmmp://pay?pa=${vpa}&pn=${name}&am=${amountRupees}&cu=INR&tn=${note}&tr=${ref}`;
  const bhimUri = `upi://pay?pa=${vpa}&pn=${name}&am=${amountRupees}&cu=INR&tn=${note}&tr=${ref}`;

  return {
    rawUpiUri,
    gpayUri,
    phonepeUri,
    paytmUri,
    bhimUri,
    amountRupees,
  };
}

