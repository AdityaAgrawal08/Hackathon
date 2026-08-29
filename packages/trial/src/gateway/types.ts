/**
 * Strict Polymorphic Payment Gateway Interface.
 *
 * Defines the operations supported by both REAL_SANDBOX (Razorpay Test Mode)
 * and LOCAL_SANDBOX (Deterministic Fault Injection).
 */

export type PaymentMode = "REAL_SANDBOX" | "LOCAL_SANDBOX";

export interface GatewayOrderInput {
  tenantId: string;
  amountPaise: number;
  currency?: string; // Default: 'INR'
  receipt: string;
  notes?: Record<string, string>;
}

export interface GatewayOrder {
  id: string; // 'order_...' (Razorpay) or 'order_local_...' (Local)
  tenantId: string;
  amountPaise: number;
  currency: string;
  status: "created" | "attempted" | "paid";
  paymentMode: PaymentMode;
  hostedUrl?: string; // Hosted payment link URL if generated
  createdAtUtc: string;
}

export interface GatewayCheckoutSessionInput {
  tenantId: string;
  orderId: string;
  amountPaise: number;
  currency?: string;
  paymentMode: PaymentMode;
  ttlSeconds?: number; // Default: 900 (15 minutes)
}

export interface GatewayCheckoutSession {
  token: string; // 32-byte opaque base64url token
  orderId: string;
  tenantId: string;
  amountPaise: number;
  currency: string;
  paymentMode: PaymentMode;
  expiresAtUtc: string;
  createdAtUtc: string;
}

export interface GatewayChargeInput {
  tenantId: string;
  orderId: string;
  clientIdemKey: string;
  amountPaise: number;
  scenario?: string; // Explicit fault profile for LOCAL_SANDBOX (e.g. 'LOCAL_INSUFFICIENT_FUNDS')
  instrument?: {
    type: "test_profile" | "card" | "upi" | "netbanking";
    testProfile?: string;
    token?: string;
    vpa?: string;
  };
}

export interface GatewayChargeResult {
  providerPaymentId: string;
  providerOrderId: string;
  status: "succeeded" | "authorized" | "failed" | "pending" | "transport_dropped";
  errorCode?: string;
  errorDescription?: string;
  latencyMs: number;
  rawResponse?: Record<string, unknown>;
}

export interface GatewayStatusResult {
  providerPaymentId: string;
  providerOrderId: string;
  provider: "razorpay" | "local";
  status: "captured" | "authorized" | "failed" | "pending";
  amountPaise: number;
  currency: string;
  errorCode?: string;
  errorDescription?: string;
  capturedAtUtc?: string;
}

export interface PaymentGateway {
  readonly mode: PaymentMode;
  createOrder(input: GatewayOrderInput): Promise<GatewayOrder>;
  fetchPayment(providerPaymentId: string): Promise<GatewayStatusResult | null>;
  charge(input: GatewayChargeInput): Promise<GatewayChargeResult>;
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;
}
