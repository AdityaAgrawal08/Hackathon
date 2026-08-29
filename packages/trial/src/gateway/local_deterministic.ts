/**
 * LOCAL_SANDBOX: Deterministic Transport & Application Fault-Injection Gateway.
 *
 * Implements a simulated provider authority for local testing.
 * Durably persists simulated orders and payments into SQLite (`provider_payments`)
 * so that crash recovery, status lookups, and reconciliation work identically
 * across process restarts.
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

export const LOCAL_FAULT_PROFILES = [
  "LOCAL_SUCCESS",
  "LOCAL_INSUFFICIENT_FUNDS",
  "LOCAL_EXPIRED_METHOD",
  "LOCAL_INVALID_DETAILS",
  "LOCAL_RISK_REJECTED",
  "LOCAL_GATEWAY_TIMEOUT",
  "LOCAL_GATEWAY_503",
  "LOCAL_LOST_RESPONSE",
  "LOCAL_DUPLICATE_SUBMIT",
] as const;

export type LocalFaultProfile = (typeof LOCAL_FAULT_PROFILES)[number];

export class LocalDeterministicGateway implements PaymentGateway {
  readonly mode = "LOCAL_SANDBOX" as const;
  private readonly client: Client;
  private readonly webhookSecret: string;
  private seenAttempts = new Map<string, number>();

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

    return {
      id: orderId,
      tenantId: input.tenantId,
      amountPaise: input.amountPaise,
      currency: input.currency ?? "INR",
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

    // 1. Duplicate submission tracking
    const attemptCount = (this.seenAttempts.get(input.clientIdemKey) ?? 0) + 1;
    this.seenAttempts.set(input.clientIdemKey, attemptCount);

    if (scenario === "LOCAL_DUPLICATE_SUBMIT" && attemptCount > 1) {
      return {
        providerPaymentId: paymentId,
        providerOrderId: input.orderId,
        status: "succeeded",
        latencyMs: 50,
      };
    }

    // 2. Controlled Fault Injection Logic
    switch (scenario) {
      case "LOCAL_SUCCESS":
      case "LOCAL_DUPLICATE_SUBMIT": {
        // Durably persist captured payment in SQLite
        await this.client.execute({
          sql: `INSERT INTO provider_payments
                  (id, provider_order_id, provider, status, amount_paise, currency, captured_at_utc, created_at_utc)
                VALUES (?, ?, 'local', 'captured', ?, 'INR', ?, ?)
                ON CONFLICT(id) DO UPDATE SET status = 'captured', captured_at_utc = excluded.captured_at_utc`,
          args: [paymentId, input.orderId, input.amountPaise, nowUtc, nowUtc],
        });
        return {
          providerPaymentId: paymentId,
          providerOrderId: input.orderId,
          status: "succeeded",
          latencyMs: 100,
        };
      }

      case "LOCAL_INSUFFICIENT_FUNDS": {
        await this.client.execute({
          sql: `INSERT INTO provider_payments
                  (id, provider_order_id, provider, status, amount_paise, currency, error_code, error_description, created_at_utc)
                VALUES (?, ?, 'local', 'failed', ?, 'INR', 'LOCAL_INSUFFICIENT_FUNDS', 'Account balance is insufficient for transaction.', ?)
                ON CONFLICT(id) DO NOTHING`,
          args: [paymentId, input.orderId, input.amountPaise, nowUtc],
        });
        return {
          providerPaymentId: paymentId,
          providerOrderId: input.orderId,
          status: "failed",
          errorCode: "LOCAL_INSUFFICIENT_FUNDS",
          errorDescription: "Account balance is insufficient for transaction.",
          latencyMs: 80,
        };
      }

      case "LOCAL_EXPIRED_METHOD": {
        await this.client.execute({
          sql: `INSERT INTO provider_payments
                  (id, provider_order_id, provider, status, amount_paise, currency, error_code, error_description, created_at_utc)
                VALUES (?, ?, 'local', 'failed', ?, 'INR', 'LOCAL_EXPIRED_METHOD', 'Payment instrument has expired.', ?)
                ON CONFLICT(id) DO NOTHING`,
          args: [paymentId, input.orderId, input.amountPaise, nowUtc],
        });
        return {
          providerPaymentId: paymentId,
          providerOrderId: input.orderId,
          status: "failed",
          errorCode: "LOCAL_EXPIRED_METHOD",
          errorDescription: "Payment instrument has expired.",
          latencyMs: 70,
        };
      }

      case "LOCAL_INVALID_DETAILS": {
        await this.client.execute({
          sql: `INSERT INTO provider_payments
                  (id, provider_order_id, provider, status, amount_paise, currency, error_code, error_description, created_at_utc)
                VALUES (?, ?, 'local', 'failed', ?, 'INR', 'LOCAL_INVALID_DETAILS', 'Supplied payment details are invalid.', ?)
                ON CONFLICT(id) DO NOTHING`,
          args: [paymentId, input.orderId, input.amountPaise, nowUtc],
        });
        return {
          providerPaymentId: paymentId,
          providerOrderId: input.orderId,
          status: "failed",
          errorCode: "LOCAL_INVALID_DETAILS",
          errorDescription: "Supplied payment details are invalid.",
          latencyMs: 60,
        };
      }

      case "LOCAL_RISK_REJECTED": {
        await this.client.execute({
          sql: `INSERT INTO provider_payments
                  (id, provider_order_id, provider, status, amount_paise, currency, error_code, error_description, created_at_utc)
                VALUES (?, ?, 'local', 'failed', ?, 'INR', 'LOCAL_RISK_REJECTED', 'Transaction blocked by risk controls.', ?)
                ON CONFLICT(id) DO NOTHING`,
          args: [paymentId, input.orderId, input.amountPaise, nowUtc],
        });
        return {
          providerPaymentId: paymentId,
          providerOrderId: input.orderId,
          status: "failed",
          errorCode: "LOCAL_RISK_REJECTED",
          errorDescription: "Transaction blocked by risk controls.",
          latencyMs: 90,
        };
      }

      case "LOCAL_GATEWAY_503": {
        return {
          providerPaymentId: paymentId,
          providerOrderId: input.orderId,
          status: "failed",
          errorCode: "LOCAL_GATEWAY_503",
          errorDescription: "Payment gateway is temporarily unavailable.",
          latencyMs: 40,
        };
      }

      case "LOCAL_GATEWAY_TIMEOUT": {
        return {
          providerPaymentId: paymentId,
          providerOrderId: input.orderId,
          status: "transport_dropped",
          errorCode: "LOCAL_GATEWAY_TIMEOUT",
          errorDescription: "Gateway connection timed out.",
          latencyMs: 30000,
        };
      }

      case "LOCAL_LOST_RESPONSE": {
        // Durably commit settlement in mock provider state, but drop the transport response
        await this.client.execute({
          sql: `INSERT INTO provider_payments
                  (id, provider_order_id, provider, status, amount_paise, currency, captured_at_utc, created_at_utc)
                VALUES (?, ?, 'local', 'captured', ?, 'INR', ?, ?)
                ON CONFLICT(id) DO UPDATE SET status = 'captured', captured_at_utc = excluded.captured_at_utc`,
          args: [paymentId, input.orderId, input.amountPaise, nowUtc, nowUtc],
        });
        return {
          providerPaymentId: paymentId,
          providerOrderId: input.orderId,
          status: "transport_dropped",
          latencyMs: 120,
        };
      }

      default:
        throw new Error(`LocalDeterministicGateway: Unknown scenario ${scenario}`);
    }
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
    const expected = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    if (expected.length !== signature.length) return false;
    return timingSafeEqual(Buffer.from(expected, "utf-8"), Buffer.from(signature, "utf-8"));
  }

  generateWebhookPayload(event: {
    eventType: string;
    orderId: string;
    paymentId: string;
    amountPaise: number;
    status: "captured" | "failed";
    errorCode?: string;
    errorDescription?: string;
  }): { rawBody: Buffer; signature: string } {
    const bodyObj = {
      entity: "event",
      account_id: "acc_local_test",
      event: event.eventType,
      contains: ["payment"],
      payload: {
        payment: {
          entity: {
            id: event.paymentId,
            entity: "payment",
            amount: event.amountPaise,
            currency: "INR",
            status: event.status,
            order_id: event.orderId,
            error_code: event.errorCode ?? null,
            error_description: event.errorDescription ?? null,
            created_at: Math.floor(Date.now() / 1000),
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    };
    const rawBody = Buffer.from(JSON.stringify(bodyObj), "utf-8");
    const signature = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    return { rawBody, signature };
  }
}
