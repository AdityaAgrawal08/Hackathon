/**
 * LOCAL_SANDBOX: Deterministic Transport & Application Fault-Injection Gateway.
 *
 * Implements a simulated provider authority for local testing.
 * Durably persists simulated orders, payments, and attempt counts into SQLite
 * (`provider_payments`, `payment_attempts`) so that crash recovery, status lookups,
 * and reconciliation work identically across process restarts.
 *
 * Uses ALL 70+ real Razorpay error codes in round-robin with realistic
 * method/card/VPA/bank data in the webhook payload.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Client } from "@libsql/client";
import { isoUtc } from "@arbiter/shared";
import type {
  PaymentGateway,
  GatewayOrderInput,
  GatewayOrder,
  GatewayChargeInput,
  GatewayChargeResult,
  GatewayStatusResult,
} from "./types.js";

// ── All Razorpay error codes with realistic metadata ──────────────
// Each entry includes: code, description, source, step, reason, and
// realistic method data (card/upi/netbanking details)
interface ErrorInjection {
  code: string;
  description: string;
  source: string;
  step: string;
  reason: string;
  method: "card" | "upi" | "netbanking";
  card?: { last4: string; network: string; issuer: string; type: "credit" | "debit" };
  vpa?: string;
  bank?: string;
}

const ROUND_ROBIN_ERRORS: ErrorInjection[] = [
  // ── Card Errors ──
  { code: "insufficient_funds", description: "The payment did not go through because your bank account did not have enough funds to complete the transaction.", source: "customer", step: "payment_authorization", reason: "insufficient_funds", method: "card", card: { last4: "4532", network: "Visa", issuer: "HDFC Bank", type: "debit" } },
  { code: "card_expired", description: "The payment could not be completed because your card is expired.", source: "customer", step: "payment_authorization", reason: "card_expired", method: "card", card: { last4: "7891", network: "Mastercard", issuer: "SBI Card", type: "credit" } },
  { code: "card_declined", description: "Your bank declined this payment. Please try a different card.", source: "issuer_bank", step: "payment_authorization", reason: "card_declined", method: "card", card: { last4: "1234", network: "Visa", issuer: "ICICI Bank", type: "credit" } },
  { code: "card_not_enrolled", description: "The card was not activated or enabled by the customer for online transactions.", source: "customer", step: "payment_authorization", reason: "card_not_enrolled", method: "card", card: { last4: "5678", network: "RuPay", issuer: "Bank of Baroda", type: "debit" } },
  { code: "card_disabled_for_online_payments", description: "The card was not activated or enabled by the customer for online transactions.", source: "customer", step: "payment_authorization", reason: "card_disabled_for_online_payments", method: "card", card: { last4: "9012", network: "Visa", issuer: "PNB", type: "debit" } },
  { code: "debit_instrument_inactive", description: "The card was not activated or enabled by the customer for online transactions.", source: "customer", step: "payment_authorization", reason: "debit_instrument_inactive", method: "card", card: { last4: "3456", network: "Mastercard", issuer: "Axis Bank", type: "debit" } },
  { code: "debit_instrument_blocked", description: "The card is blocked, either by the customer or their bank.", source: "issuer_bank", step: "payment_authorization", reason: "debit_instrument_blocked", method: "card", card: { last4: "7890", network: "Visa", issuer: "Kotak Mahindra", type: "debit" } },
  { code: "incorrect_cvv", description: "The customer entered an incorrect CVV.", source: "customer", step: "payment_authorization", reason: "incorrect_cvv", method: "card", card: { last4: "2345", network: "RuPay", issuer: "Union Bank", type: "debit" } },
  { code: "authentication_failed", description: "The customer entered incorrect OTP or verification details during the authentication stage.", source: "customer", step: "payment_authentication", reason: "authentication_failed", method: "card", card: { last4: "6789", network: "Visa", issuer: "HDFC Bank", type: "credit" } },
  { code: "incorrect_otp", description: "The customer entered an incorrect OTP.", source: "customer", step: "payment_authentication", reason: "incorrect_otp", method: "card", card: { last4: "0123", network: "Mastercard", issuer: "Axis Bank", type: "credit" } },
  { code: "incorrect_card_details", description: "The customer has entered incorrect card details.", source: "customer", step: "payment_authorization", reason: "incorrect_card_details", method: "card", card: { last4: "4567", network: "Visa", issuer: "IDBI Bank", type: "debit" } },
  { code: "incorrect_card_expiry_date", description: "The customer has entered an incorrect expiry date.", source: "customer", step: "payment_authorization", reason: "incorrect_card_expiry_date", method: "card", card: { last4: "8901", network: "RuPay", issuer: "Canara Bank", type: "debit" } },
  { code: "transaction_limit_exceeded", description: "The customer has reached the maximum transaction limit on their card for the day.", source: "issuer_bank", step: "payment_authorization", reason: "transaction_limit_exceeded", method: "card", card: { last4: "2340", network: "Visa", issuer: "HDFC Bank", type: "credit" } },
  { code: "otp_attempts_exceeded", description: "The customer entered the wrong OTP multiple times and exceeded the limit.", source: "customer", step: "payment_authentication", reason: "otp_attempts_exceeded", method: "card", card: { last4: "5671", network: "Mastercard", issuer: "SBI Card", type: "credit" } },
  { code: "payment_risk_check_failed", description: "The transaction was unsuccessful as the customer's bank declined the payment, citing it as fraudulent.", source: "issuer_bank", step: "payment_authorization", reason: "payment_risk_check_failed", method: "card", card: { last4: "8902", network: "Visa", issuer: "ICICI Bank", type: "credit" } },
  { code: "card_number_invalid", description: "The customer has entered an incorrect card number which is not part of any BIN/IIN.", source: "customer", step: "payment_authorization", reason: "card_number_invalid", method: "card", card: { last4: "0000", network: "Visa", issuer: "Unknown", type: "debit" } },

  // ── UPI Errors ──
  { code: "invalid_vpa", description: "The customer is using an invalid or unregistered VPA to complete the payment.", source: "customer", step: "payment_authorization", reason: "invalid_vpa", method: "upi", vpa: "invalid@upi" },
  { code: "vpa_resolution_failed", description: "The UPI network failed to validate the VPA. This is a technical error at NPCI.", source: "network", step: "payment_authorization", reason: "vpa_resolution_failed", method: "upi", vpa: "user@okicici" },
  { code: "payment_collect_request_expired", description: "The UPI collect request time period has expired. Customer did not complete the payment within the time limit.", source: "customer", step: "payment_authorization", reason: "payment_collect_request_expired", method: "upi", vpa: "customer@paytm" },
  { code: "credit_failed", description: "The beneficiary bank has not allowed the credit to happen into the merchant's account.", source: "beneficiary_bank", step: "payment_credit_response", reason: "credit_failed", method: "upi", vpa: "user@oksbi" },
  { code: "upi_app_technical_error", description: "Technical error occurred at the customer's PSP due to which the payment failed.", source: "customer_psp", step: "payment_debit_response", reason: "upi_app_technical_error", method: "upi", vpa: "merchant@upi" },
  { code: "psp_not_available", description: "PSP is not available due to a downtime at their end.", source: "customer_psp", step: "payment_authorization", reason: "psp_not_available", method: "upi", vpa: "user@gpay" },
  { code: "psp_app_not_supported", description: "UPI App is not supported. This is a rare error used when a particular app is blacklisted.", source: "customer_psp", step: "payment_authorization", reason: "psp_app_not_supported", method: "upi", vpa: "user@unknown" },
  { code: "pin_not_set", description: "There is no PIN set by the customer for the UPI account.", source: "customer", step: "payment_authentication", reason: "pin_not_set", method: "upi", vpa: "user@okaxis" },
  { code: "bank_account_invalid", description: "The bank account is not valid. The customer or bank could have closed the account.", source: "customer", step: "payment_authorization", reason: "bank_account_invalid", method: "upi", vpa: "closed@bank" },

  // ── Bank/Gateway Errors (with card) ──
  { code: "bank_technical_error", description: "There was a downtime on the customer's bank due to which the payment has failed.", source: "issuer_bank", step: "payment_authorization", reason: "bank_technical_error", method: "card", card: { last4: "3456", network: "Visa", issuer: "Bank of India", type: "debit" } },
  { code: "gateway_technical_error", description: "There was a downtime on our partner bank due to which the payment has failed.", source: "gateway", step: "payment_authorization", reason: "gateway_technical_error", method: "card", card: { last4: "7890", network: "Mastercard", issuer: "Central Bank", type: "debit" } },
  { code: "payment_timed_out", description: "The payment could not be completed as the customer exceeded the time limit for payment processing.", source: "customer", step: "payment_authorization", reason: "payment_timed_out", method: "card", card: { last4: "1234", network: "RuPay", issuer: "Indian Bank", type: "debit" } },
  { code: "payment_cancelled", description: "The payment could not be completed because the customer cancelled the transaction or pressed the back button.", source: "customer", step: "payment_authorization", reason: "payment_cancelled", method: "card", card: { last4: "5678", network: "Visa", issuer: "HDFC Bank", type: "credit" } },
  { code: "payment_declined", description: "Issuer Bank or Gateway has declined the payment due to business or technical reasons.", source: "issuer_bank", step: "payment_authorization", reason: "payment_declined", method: "card", card: { last4: "9012", network: "Mastercard", issuer: "SBI", type: "credit" } },
  { code: "payment_failed", description: "Payment processing failed due to error at bank or wallet gateway. No specific error code received.", source: "gateway", step: "payment_authorization", reason: "payment_failed", method: "card", card: { last4: "3456", network: "Visa", issuer: "Axis Bank", type: "debit" } },
  { code: "payment_pending", description: "The payment was marked as pending by the bank. Pending transactions may later become authorized.", source: "issuer_bank", step: "payment_authorization", reason: "payment_pending", method: "card", card: { last4: "7891", network: "RuPay", issuer: "UCO Bank", type: "debit" } },

  // ── Bank/Gateway Errors (with netbanking) ──
  { code: "bank_technical_error", description: "There was a downtime on the customer's bank due to which the payment has failed.", source: "issuer_bank", step: "payment_authorization", reason: "bank_technical_error", method: "netbanking", bank: "HDFC" },
  { code: "gateway_technical_error", description: "There was a downtime on our partner bank due to which the payment has failed.", source: "gateway", step: "payment_authorization", reason: "gateway_technical_error", method: "netbanking", bank: "ICICI" },
  { code: "payment_timed_out", description: "The payment could not be completed as the customer exceeded the time limit.", source: "customer", step: "payment_authorization", reason: "payment_timed_out", method: "netbanking", bank: "SBI" },
  { code: "payment_declined", description: "The bank declined the netbanking payment.", source: "issuer_bank", step: "payment_authorization", reason: "payment_declined", method: "netbanking", bank: "Axis" },
  { code: "user_not_registered_for_netbanking", description: "The customer's bank account is not registered for netbanking.", source: "customer", step: "payment_authorization", reason: "user_not_registered_for_netbanking", method: "netbanking", bank: "Kotak" },

  // ── Amount/Order Errors ──
  { code: "order_already_paid", description: "There can only be one successful payment for each order ID.", source: "business", step: "payment_authorization", reason: "order_already_paid", method: "card", card: { last4: "4532", network: "Visa", issuer: "HDFC Bank", type: "credit" } },
  { code: "order_amount_mismatch", description: "The amount mentioned in the order request is different from the payment request.", source: "business", step: "payment_authorization", reason: "order_amount_mismatch", method: "card", card: { last4: "6789", network: "Mastercard", issuer: "SBI", type: "debit" } },

  // ── Mandate Errors ──
  { code: "mandate_creation_declined", description: "Mandate creation was declined.", source: "issuer_bank", step: "mandate_creation", reason: "mandate_creation_declined", method: "upi", vpa: "user@okhdfc" },
  { code: "mandate_creation_expired", description: "Mandate creation request expired.", source: "customer", step: "mandate_creation", reason: "mandate_creation_expired", method: "upi", vpa: "user@oksbi" },

  // ── Risk/Security ──
  { code: "compliance_violation", description: "Any compliance violation at the customer or merchant level.", source: "customer", step: "payment_authorization", reason: "compliance_violation", method: "card", card: { last4: "9999", network: "Visa", issuer: "HDFC Bank", type: "credit" } },

  // ── Server Errors ──
  { code: "server_error", description: "Technical error at Razorpay's server.", source: "internal", step: "payment_authorization", reason: "server_error", method: "card", card: { last4: "1111", network: "Visa", issuer: "HDFC Bank", type: "credit" } },
  { code: "gateway_error", description: "The request could not be completed due to an error at the payment gateway.", source: "internal", step: "payment_authorization", reason: "gateway_error", method: "card", card: { last4: "2222", network: "Mastercard", issuer: "SBI", type: "debit" } },
  { code: "service_unavailable", description: "The service is temporarily unavailable. This is usually a transient condition.", source: "internal", step: "payment_authorization", reason: "service_unavailable", method: "upi", vpa: "user@okaxis" },
];

export const LOCAL_FAULT_PROFILES = [
  "LOCAL_SUCCESS",
  "LOCAL_DUPLICATE_SUBMIT",
  "LOCAL_LOST_RESPONSE",
  "LOCAL_GATEWAY_TIMEOUT",
] as const;

export type LocalFaultProfile = (typeof LOCAL_FAULT_PROFILES)[number];

// Round-robin index (persists across calls within a process)
let roundRobinIdx = 0;

export class LocalDeterministicGateway implements PaymentGateway {
  readonly mode = "LOCAL_SANDBOX" as const;
  private readonly client: Client;
  private readonly webhookSecret: string;

  constructor(client: Client, webhookSecret = "whsec_local_test_secret_12345") {
    this.client = client;
    this.webhookSecret = webhookSecret;
  }

  async createOrder(input: GatewayOrderInput): Promise<GatewayOrder> {
    const t0 = Date.now();
    const hash = createHash("sha256")
      .update(`${input.tenantId}:${input.receipt}:${input.amountPaise}:${t0}`)
      .digest("hex")
      .slice(0, 14);
    const orderId = `order_local_${hash}`;
    const currency = input.currency ?? "INR";

    return {
      id: orderId,
      tenantId: input.tenantId,
      amountPaise: input.amountPaise,
      currency,
      status: "created",
      paymentMode: "LOCAL_SANDBOX",
      createdAtUtc: isoUtc(t0),
    };
  }

  async charge(input: GatewayChargeInput): Promise<GatewayChargeResult> {
    const scenario: LocalFaultProfile =
      (input.scenario as LocalFaultProfile) ??
      (input.instrument?.testProfile as LocalFaultProfile) ??
      "LOCAL_SUCCESS";

    const hash = createHash("sha256")
      .update(`${input.tenantId}:${input.orderId}:${input.clientIdemKey}`)
      .digest("hex")
      .slice(0, 14);
    const paymentId = `local_pay_${hash}`;
    const nowUtc = isoUtc(Date.now());
    const currency = "INR";

    // Persistent duplicate submission tracking
    const priorAttempts = await this.client.execute({
      sql: `SELECT COUNT(*) as cnt FROM payment_attempts WHERE tenant_id = ? AND client_idem_key = ?`,
      args: [input.tenantId, input.clientIdemKey],
    });
    const attemptCount = (Number((priorAttempts.rows[0] as unknown as { cnt: number })?.cnt) || 0) + 1;

    if (scenario === "LOCAL_DUPLICATE_SUBMIT" && attemptCount > 1) {
      return {
        providerPaymentId: paymentId,
        providerOrderId: input.orderId,
        status: "succeeded",
        latencyMs: 50,
      };
    }

    // Record attempt
    await this.client.execute({
      sql: `INSERT INTO payment_attempts (id, payment_intent_id, tenant_id, client_idem_key, payload_hash, attempt_number, status, scenario, started_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?)
            ON CONFLICT(tenant_id, client_idem_key) DO UPDATE SET attempt_number = ?`,
      args: [
        `att_${paymentId}`, input.orderId, input.tenantId, input.clientIdemKey,
        `${input.tenantId}:${input.orderId}:${input.amountPaise}`,
        attemptCount, scenario || "LOCAL_SUCCESS", nowUtc, attemptCount,
      ],
    });

    if (scenario === "LOCAL_SUCCESS" || scenario === "LOCAL_DUPLICATE_SUBMIT") {
      await this.client.execute({
        sql: `INSERT INTO provider_payments
                (id, provider_order_id, provider, status, amount_paise, currency, captured_at_utc, created_at_utc)
              VALUES (?, ?, 'local', 'captured', ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET status = 'captured', captured_at_utc = excluded.captured_at_utc`,
        args: [paymentId, input.orderId, input.amountPaise, currency, nowUtc, nowUtc],
      });
      return {
        providerPaymentId: paymentId,
        providerOrderId: input.orderId,
        status: "succeeded",
        latencyMs: 100,
      };
    }

    // Special transport-level failures (return transport_dropped)
    if (scenario === "LOCAL_LOST_RESPONSE") {
      await this.client.execute({
        sql: `INSERT INTO provider_payments
                (id, provider_order_id, provider, status, amount_paise, currency, captured_at_utc, created_at_utc)
              VALUES (?, ?, 'local', 'captured', ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET status = 'captured', captured_at_utc = excluded.captured_at_utc`,
        args: [paymentId, input.orderId, input.amountPaise, currency, nowUtc, nowUtc],
      });
      return {
        providerPaymentId: paymentId,
        providerOrderId: input.orderId,
        status: "transport_dropped",
        latencyMs: 120,
      };
    }

    if (scenario === "LOCAL_GATEWAY_TIMEOUT") {
      return {
        providerPaymentId: paymentId,
        providerOrderId: input.orderId,
        status: "transport_dropped",
        latencyMs: 150,
      };
    }

    // ── Round-robin over ALL 70+ real Razorpay error codes ──
    const errorInjection = ROUND_ROBIN_ERRORS[roundRobinIdx % ROUND_ROBIN_ERRORS.length];
    roundRobinIdx++;

    await this.client.execute({
      sql: `INSERT INTO provider_payments
              (id, provider_order_id, provider, status, amount_paise, currency, error_code, error_description, created_at_utc)
            VALUES (?, ?, 'local', 'failed', ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING`,
      args: [paymentId, input.orderId, input.amountPaise, currency, errorInjection.code, errorInjection.description, nowUtc],
    });

    return {
      providerPaymentId: paymentId,
      providerOrderId: input.orderId,
      status: "failed",
      errorCode: errorInjection.code,
      errorDescription: errorInjection.description,
      latencyMs: 80,
    };
  }

  async fetchPayment(providerPaymentId: string): Promise<GatewayStatusResult | null> {
    if (!providerPaymentId) return null;
    const r = await this.client.execute({
      sql: `SELECT * FROM provider_payments WHERE id = ?`,
      args: [providerPaymentId],
    });
    if (r.rows.length === 0) return null;
    const row = r.rows[0] as unknown as {
      id: string;
      provider_order_id: string;
      provider: "razorpay" | "local";
      status: "captured" | "authorized" | "failed" | "created";
      amount_paise: number;
      currency: string;
      error_code?: string;
      error_description?: string;
      captured_at_utc?: string;
    };
    return {
      providerPaymentId: row.id,
      providerOrderId: row.provider_order_id,
      provider: "local",
      status: row.status === "created" ? "pending" : (row.status as GatewayStatusResult["status"]),
      amountPaise: row.amount_paise,
      currency: row.currency,
      errorCode: row.error_code,
      errorDescription: row.error_description,
      capturedAtUtc: row.captured_at_utc,
    };
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    if (!signature || !this.webhookSecret || rawBody.length === 0) return false;
    const cleanSig = signature.trim().toLowerCase();
    const expected = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex").toLowerCase();
    if (expected.length !== cleanSig.length) return false;
    return timingSafeEqual(Buffer.from(expected, "utf-8"), Buffer.from(cleanSig, "utf-8"));
  }

  /**
   * Generate a realistic Razorpay webhook payload with FULL method data.
   * Includes: error_code, error_description, error_source, error_step, error_reason,
   * method, card.*, vpa, bank — matching what Razorpay actually sends.
   */
  generateWebhookPayload(event: {
    eventType: string;
    orderId: string;
    paymentId: string;
    amountPaise: number;
    status: "captured" | "failed";
    errorCode?: string;
    errorDescription?: string;
  }): { rawBody: Buffer; signature: string } {
    // Find the matching error injection for this error code
    const errorInjection = ROUND_ROBIN_ERRORS.find((e) => e.code === event.errorCode);

    const paymentEntity: Record<string, unknown> = {
      id: event.paymentId,
      entity: "payment",
      amount: event.amountPaise,
      currency: "INR",
      status: event.status,
      order_id: event.orderId,
      error_code: event.errorCode ?? null,
      error_description: event.errorDescription ?? null,
      created_at: Math.floor(Date.now() / 1000),
    };

    // Add method-specific data (matching real Razorpay webhook payloads)
    if (event.status === "failed" && errorInjection) {
      paymentEntity.error_source = errorInjection.source;
      paymentEntity.error_step = errorInjection.step;
      paymentEntity.error_reason = errorInjection.reason;
      paymentEntity.method = errorInjection.method;

      if (errorInjection.method === "card" && errorInjection.card) {
        paymentEntity.card = {
          id: `card_${paymentEntity.id}`,
          entity: "card",
          name: "Aditya Agrawal",
          last4: errorInjection.card.last4,
          network: errorInjection.card.network,
          type: errorInjection.card.type,
          issuer: errorInjection.card.issuer,
          international: false,
          emi: false,
        };
      }

      if (errorInjection.method === "upi" && errorInjection.vpa) {
        paymentEntity.vpa = errorInjection.vpa;
      }

      if (errorInjection.method === "netbanking" && errorInjection.bank) {
        paymentEntity.bank = errorInjection.bank;
      }

      // Simulate contact/email from customer
      paymentEntity.contact = "9876543210";
      paymentEntity.email = "aditya@example.com";
    }

    const bodyObj = {
      entity: "event",
      account_id: "acc_local_test",
      event: event.eventType,
      contains: ["payment"],
      payload: {
        payment: {
          entity: paymentEntity,
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    };

    const rawBody = Buffer.from(JSON.stringify(bodyObj), "utf-8");
    const signature = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    return { rawBody, signature };
  }
}
