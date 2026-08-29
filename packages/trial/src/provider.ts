/**
 * MockRazorpayProvider — a fully sandboxed simulation of a Razorpay-style PSP.
 *
 * NO real network, NO real money, NO real gateway. Every outcome is derived
 * from the scenario id + the client idempotency key, so it is perfectly
 * reproducible and can never perform a real financial transaction.
 *
 * It models the *provider-side* behaviors that production payment flows must
 * survive: success, insufficient funds, network down, timeout, unavailable,
 * invalid/expired details, duplicate, cancellation, rejection, auth expiry,
 * server error, client disconnect, the dangerous "charged but response lost"
 * case, uncertain states, concurrency, slow network, and rate limiting.
 */
import { createHash } from "node:crypto";
import type { ChargeInput, ChargeProvider, ChargeResult, ProviderStatus } from "@arbiter/core/executor";

interface ProviderScript {
  status: ProviderStatus;
  delivered: boolean;
  latencyMs: number;
  errorCode?: string;
  errorMessage?: string;
}

/** Per-scenario provider behavior. Keyed by scenario id (see scenarios.ts). */
export const PROVIDER_SCRIPT: Record<string, ProviderScript> = {
  successful_payment: { status: "succeeded", delivered: true, latencyMs: 120 },
  insufficient_balance: {
    status: "insufficient_funds",
    delivered: true,
    latencyMs: 90,
    errorCode: "RZP_INSUFFICIENT_FUNDS",
    errorMessage: "The customer's account had insufficient balance.",
  },
  no_internet: {
    status: "network_down",
    delivered: false,
    latencyMs: 0,
    errorCode: "RZP_NETWORK_DOWN",
    errorMessage: "Could not reach the payment network.",
  },
  gateway_timeout: {
    status: "timeout",
    delivered: false,
    latencyMs: 30_000,
    errorCode: "RZP_TIMEOUT",
    errorMessage: "The payment gateway did not respond in time.",
  },
  gateway_unavailable: {
    status: "unavailable",
    delivered: false,
    latencyMs: 500,
    errorCode: "RZP_UNAVAILABLE",
    errorMessage: "The payment gateway is temporarily unavailable.",
  },
  invalid_details: {
    status: "invalid_details",
    delivered: true,
    latencyMs: 80,
    errorCode: "RZP_INVALID_DETAILS",
    errorMessage: "The supplied payment details were invalid.",
  },
  expired_method: {
    status: "expired_method",
    delivered: true,
    latencyMs: 70,
    errorCode: "RZP_EXPIRED_METHOD",
    errorMessage: "The saved payment method has expired.",
  },
  duplicate_request: {
    status: "duplicate",
    delivered: true,
    latencyMs: 140,
    errorCode: "RZP_DUPLICATE",
    errorMessage: "This looks like a duplicate of an already-collected payment.",
  },
  multiple_submits: {
    status: "duplicate",
    delivered: true,
    latencyMs: 140,
    errorCode: "RZP_DUPLICATE",
    errorMessage: "This looks like a duplicate of an already-collected payment.",
  },
  cancelled_by_user: {
    status: "cancelled",
    delivered: true,
    latencyMs: 60,
    errorCode: "RZP_CANCELLED",
    errorMessage: "The customer cancelled the payment.",
  },
  rejected_by_provider: {
    status: "rejected",
    delivered: true,
    latencyMs: 110,
    errorCode: "RZP_REJECTED",
    errorMessage: "The issuing bank rejected the charge.",
  },
  auth_expiry: {
    status: "auth_expired",
    delivered: true,
    latencyMs: 75,
    errorCode: "RZP_AUTH_EXPIRED",
    errorMessage: "The session authorization expired during payment.",
  },
  server_error: {
    status: "server_error",
    delivered: false,
    latencyMs: 800,
    errorCode: "RZP_SERVER_ERROR",
    errorMessage: "The payment provider returned an internal error.",
  },
  client_disconnect: {
    status: "client_disconnect",
    delivered: false,
    latencyMs: 600,
    errorCode: "RZP_CLIENT_DISCONNECT",
    errorMessage: "The client disconnected before the response arrived.",
  },
  success_lost_response: { status: "lost_response", delivered: false, latencyMs: 150 },
  retry_after_uncertain: { status: "timeout", delivered: false, latencyMs: 30_000, errorCode: "RZP_TIMEOUT", errorMessage: "The payment gateway did not respond in time." },
  concurrent_attempts: { status: "succeeded", delivered: true, latencyMs: 130 },
  idempotency_repeat: {
    status: "duplicate",
    delivered: true,
    latencyMs: 130,
    errorCode: "RZP_DUPLICATE",
    errorMessage: "This looks like a duplicate of an already-collected payment.",
  },
  slow_network: { status: "slow_network", delivered: true, latencyMs: 12_000 },
  rate_limiting: {
    status: "rate_limited",
    delivered: true,
    latencyMs: 100,
    errorCode: "RZP_RATE_LIMITED",
    errorMessage: "Too many requests — the provider is rate limiting.",
  },
};

export function deterministicChargeId(clientIdemKey: string): string {
  return `ch_${createHash("sha256").update(clientIdemKey).digest("hex").slice(0, 16)}`;
}

export class MockRazorpayProvider implements ChargeProvider {
  readonly name = "mock-razorpay";
  /** Per-scenario call counter, used to replay "duplicate" scenarios correctly. */
  private seen = new Map<string, number>();

  async charge(input: ChargeInput): Promise<ChargeResult> {
    const script = PROVIDER_SCRIPT[input.scenario];
    if (!script) {
      // Unknown scenario ⇒ treat as a provider error so the trial fails loudly.
      return {
        status: "server_error",
        delivered: false,
        latencyMs: 0,
        errorCode: "RZP_UNKNOWN_SCENARIO",
        errorMessage: `No provider script for scenario ${input.scenario}`,
      };
    }
    const chargeId = deterministicChargeId(input.clientIdemKey);
    // A "duplicate" outcome models a real gateway: the FIRST attempt is the
    // original collection (success); subsequent replays of the same idempotency
    // key are reported as duplicates (already collected). The executor turns the
    // duplicate replay into an idempotent success with NO new charge.
    if (script.status === "duplicate") {
      const n = (this.seen.get(input.scenario) ?? 0) + 1;
      this.seen.set(input.scenario, n);
      if (n === 1) {
        return { status: "succeeded", delivered: true, chargeId, latencyMs: script.latencyMs, errorCode: undefined, errorMessage: undefined };
      }
      return {
        status: "duplicate",
        delivered: true,
        chargeId,
        latencyMs: script.latencyMs,
        errorCode: script.errorCode,
        errorMessage: script.errorMessage,
      };
    }
    this.seen.set(input.scenario, (this.seen.get(input.scenario) ?? 0) + 1);
    // Simulate the (sandboxed) network latency deterministically.
    await new Promise((r) => setTimeout(r, Math.min(script.latencyMs, 5)));
    return {
      status: script.status,
      delivered: script.delivered,
      chargeId,
      latencyMs: script.latencyMs,
      errorCode: script.errorCode,
      errorMessage: script.errorMessage,
    };
  }
}
