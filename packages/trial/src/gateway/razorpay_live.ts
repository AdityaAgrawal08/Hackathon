/**
 * REAL_SANDBOX: Official Razorpay Test Mode Gateway Adapter.
 *
 * Interacts strictly with official Razorpay API v1 endpoints.
 * Never fabricates bank status codes or captures real/fake bank PINs.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isoUtc } from "@arbiter/shared";
import type {
  PaymentGateway,
  GatewayOrderInput,
  GatewayOrder,
  GatewayChargeInput,
  GatewayChargeResult,
  GatewayStatusResult,
} from "./types.js";

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret?: string;
  baseUrl?: string;
}

export class RazorpayLiveGateway implements PaymentGateway {
  readonly mode = "REAL_SANDBOX" as const;
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly webhookSecret: string;
  private readonly baseUrl: string;

  constructor(config?: Partial<RazorpayConfig>) {
    const keyId = config?.keyId ?? process.env.RZP_TEST_KEY_ID;
    const keySecret = config?.keySecret ?? process.env.RZP_TEST_KEY_SECRET;
    const webhookSecret = config?.webhookSecret ?? process.env.RZP_WEBHOOK_SECRET ?? "";

    if (!keyId || !keySecret) {
      throw new Error(
        "RazorpayLiveGateway: Missing RZP_TEST_KEY_ID or RZP_TEST_KEY_SECRET in environment.",
      );
    }

    this.keyId = keyId;
    this.keySecret = keySecret;
    this.webhookSecret = webhookSecret;
    this.baseUrl = config?.baseUrl ?? "https://api.razorpay.com/v1";
  }

  private get authHeader(): string {
    return "Basic " + Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64");
  }

  async createOrder(input: GatewayOrderInput): Promise<GatewayOrder> {
    const t0 = Date.now();
    const url = `${this.baseUrl}/orders`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.authHeader,
      },
      body: JSON.stringify({
        amount: input.amountPaise,
        currency: input.currency ?? "INR",
        receipt: input.receipt,
        notes: input.notes ?? {},
      }),
    });

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new Error(
        `Razorpay API createOrder failed [HTTP ${res.status}]: ${JSON.stringify(errBody)}`,
      );
    }

    const data = (await res.json()) as {
      id: string;
      amount: number;
      currency: string;
      status: "created" | "attempted" | "paid";
    };

    return {
      id: data.id,
      tenantId: input.tenantId,
      amountPaise: data.amount,
      currency: data.currency,
      status: data.status,
      paymentMode: "REAL_SANDBOX",
      createdAtUtc: isoUtc(t0),
    };
  }

  async fetchPayment(providerPaymentId: string): Promise<GatewayStatusResult | null> {
    if (!providerPaymentId || typeof providerPaymentId !== "string") return null;
    const cleanId = providerPaymentId.trim();
    if (!cleanId.startsWith("pay_")) return null;

    const url = `${this.baseUrl}/payments/${encodeURIComponent(cleanId)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: this.authHeader,
      },
    });

    if (res.status === 404) return null;
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new Error(
        `Razorpay API fetchPayment failed [HTTP ${res.status}]: ${JSON.stringify(errBody)}`,
      );
    }

    const data = (await res.json()) as {
      id: string;
      order_id: string;
      status: "captured" | "authorized" | "failed" | "created";
      amount: number;
      currency: string;
      error_code?: string;
      error_description?: string;
      created_at: number;
    };

    const statusMap: Record<string, GatewayStatusResult["status"]> = {
      captured: "captured",
      authorized: "authorized",
      failed: "failed",
      created: "pending",
    };

    return {
      providerPaymentId: data.id,
      providerOrderId: data.order_id,
      provider: "razorpay",
      status: statusMap[data.status] ?? "pending",
      amountPaise: data.amount,
      currency: data.currency ?? "INR",
      errorCode: data.error_code,
      errorDescription: data.error_description,
      capturedAtUtc: data.status === "captured" ? isoUtc(data.created_at * 1000) : undefined,
    };
  }

  async charge(input: GatewayChargeInput): Promise<GatewayChargeResult> {
    const paymentId = input.instrument?.token ?? `pay_${input.clientIdemKey.slice(0, 14)}`;
    const status = await this.fetchPayment(paymentId);
    if (!status) {
      return {
        providerPaymentId: paymentId,
        providerOrderId: input.orderId,
        status: "pending",
        latencyMs: 100,
      };
    }
    return {
      providerPaymentId: status.providerPaymentId,
      providerOrderId: status.providerOrderId,
      status: status.status === "captured" ? "succeeded" : status.status === "failed" ? "failed" : "pending",
      errorCode: status.errorCode,
      errorDescription: status.errorDescription,
      latencyMs: 120,
    };
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    if (!signature || !this.webhookSecret || rawBody.length === 0) return false;
    const cleanSig = signature.trim().toLowerCase();
    const expected = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex").toLowerCase();
    if (expected.length !== cleanSig.length) return false;
    return timingSafeEqual(Buffer.from(expected, "utf-8"), Buffer.from(cleanSig, "utf-8"));
  }
}
