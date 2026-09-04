/**
 * The 20 production-like payment-trial scenarios (Track 3 recovery collection).
 * Each maps a real-world failure/recovery case to: the failed-payment class we
 * diagnose, the recovery action ARBITER proposes, and the pattern the trial
 * harness runs (single attempt / retry / lost-response / uncertain→reconcile /
 * concurrent). The provider behavior for each scenario lives in provider.ts
 * (PROVIDER_SCRIPT), keyed by `id`.
 */

export type TrialPattern = "single" | "retry" | "lostResponse" | "uncertainReconcile" | "concurrent";

export interface Scenario {
  id: string;
  title: string;
  failureCode: string;
  failureClass: string;
  action: string;
  pattern: TrialPattern;
  /** Extra identical retries for the "retry" pattern (>=1). */
  retryCount?: number;
  summary: string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "successful_payment",
    title: "Successful payment",
    failureCode: "INSUFFICIENT_FUNDS",
    failureClass: "SOFT_RETRYABLE",
    action: "RETRY_NOW",
    pattern: "single",
    summary: "Recovery collection succeeds; balance debited once; intent SUCCEEDED.",
  },
  {
    id: "insufficient_balance",
    title: "Insufficient account balance",
    failureCode: "INSUFFICIENT_FUNDS",
    failureClass: "SOFT_RETRYABLE",
    action: "RECOVER_WHATSAPP",
    pattern: "single",
    summary: "Provider declines (insufficient funds); no debit; user prompted to switch to alternate bank account or try again later.",
  },
  {
    id: "no_internet",
    title: "No internet / network connection",
    failureCode: "NETWORK_ERROR",
    failureClass: "NETWORK_TIMEOUT",
    action: "RECOVER_VOICE_HI",
    pattern: "uncertainReconcile",
    summary: "Network down → uncertain; intent UNKNOWN; later reconcile settles safely (no double charge).",
  },
  {
    id: "gateway_timeout",
    title: "Payment gateway timeout",
    failureCode: "GATEWAY_TIMEOUT",
    failureClass: "NETWORK_TIMEOUT",
    action: "RETRY_NOW",
    pattern: "uncertainReconcile",
    summary: "Provider times out → uncertain; reconcile (webhook) settles exactly once.",
  },
  {
    id: "gateway_unavailable",
    title: "Payment gateway unavailable",
    failureCode: "ISSUER_TIMEOUT",
    failureClass: "NETWORK_TIMEOUT",
    action: "RETRY_NOW",
    pattern: "uncertainReconcile",
    summary: "Gateway 503 → uncertain; reconcile settles once.",
  },
  {
    id: "invalid_details",
    title: "Invalid payment details",
    failureCode: "INVALID_CARD",
    failureClass: "HARD_METHOD_DEAD",
    action: "ALTERNATE_UPI_LINK",
    pattern: "single",
    summary: "Provider rejects details; no debit; user told to update details.",
  },
  {
    id: "expired_method",
    title: "Expired payment method",
    failureCode: "CARD_EXPIRED",
    failureClass: "HARD_METHOD_DEAD",
    action: "ALTERNATE_UPI_LINK",
    pattern: "single",
    summary: "Saved card expired; no debit; user told to add new method.",
  },
  {
    id: "duplicate_request",
    title: "Duplicate payment request",
    failureCode: "DUPLICATE_REQUEST",
    failureClass: "DUPLICATE",
    action: "RECOVER_WHATSAPP",
    pattern: "retry",
    retryCount: 1,
    summary: "Same idempotency key sent twice → second is idempotent; ONE charge only.",
  },
  {
    id: "multiple_submits",
    title: "Payment request submitted multiple times",
    failureCode: "MULTIPLE_SUBMITS",
    failureClass: "DUPLICATE",
    action: "RECOVER_WHATSAPP",
    pattern: "retry",
    retryCount: 2,
    summary: "Three identical submits → all but the first are idempotent; ONE charge.",
  },
  {
    id: "cancelled_by_user",
    title: "Payment cancelled by the user",
    failureCode: "INSUFFICIENT_FUNDS",
    failureClass: "SOFT_RETRYABLE",
    action: "RETRY_NOW",
    pattern: "single",
    summary: "User cancels → intent CANCELLED; no debit; retry not allowed.",
  },
  {
    id: "rejected_by_provider",
    title: "Payment rejected by the provider",
    failureCode: "INSUFFICIENT_FUNDS",
    failureClass: "SOFT_RETRYABLE",
    action: "RETRY_NOW",
    pattern: "single",
    summary: "Issuer rejects → FAILED; no debit; user told to try another method.",
  },
  {
    id: "auth_expiry",
    title: "Session/authentication expiry during payment",
    failureCode: "AUTH_EXPIRED",
    failureClass: "SOFT_RETRYABLE",
    action: "RETRY_NOW",
    pattern: "single",
    summary: "Auth expired mid-payment → FAILED; no debit; user re-authes.",
  },
  {
    id: "server_error",
    title: "Server error during payment",
    failureCode: "NETWORK_ERROR",
    failureClass: "NETWORK_TIMEOUT",
    action: "RETRY_NOW",
    pattern: "uncertainReconcile",
    summary: "Provider 500 → uncertain; reconcile settles once (no double charge).",
  },
  {
    id: "client_disconnect",
    title: "Client disconnects after submitting payment",
    failureCode: "INSUFFICIENT_FUNDS",
    failureClass: "SOFT_RETRYABLE",
    action: "RETRY_NOW",
    pattern: "uncertainReconcile",
    summary: "Client dropped before response → uncertain; reconcile settles once.",
  },
  {
    id: "success_lost_response",
    title: "Provider charged but response lost (THE hazard)",
    failureCode: "INSUFFICIENT_FUNDS",
    failureClass: "SOFT_RETRYABLE",
    action: "RECOVER_WHATSAPP",
    pattern: "lostResponse",
    summary:
      "Charge applied, response lost → client sees UNKNOWN. Retry with same key returns SUCCEEDED (idempotent) — balance debited EXACTLY once. No double charge.",
  },
  {
    id: "retry_after_uncertain",
    title: "Retry after an uncertain payment state",
    failureCode: "GATEWAY_TIMEOUT",
    failureClass: "NETWORK_TIMEOUT",
    action: "RETRY_NOW",
    pattern: "uncertainReconcile",
    summary: "Uncertain → retry is idempotent (ALREADY_SUBMITTED) → reconcile settles once.",
  },
  {
    id: "concurrent_attempts",
    title: "Concurrent payment attempts",
    failureCode: "INSUFFICIENT_FUNDS",
    failureClass: "SOFT_RETRYABLE",
    action: "RETRY_NOW",
    pattern: "concurrent",
    summary: "Two in-flight requests same key → one wins, other idempotent; ONE charge.",
  },
  {
    id: "idempotency_repeat",
    title: "Idempotency / repeated-request handling",
    failureCode: "DUPLICATE_REQUEST",
    failureClass: "DUPLICATE",
    action: "RECOVER_WHATSAPP",
    pattern: "retry",
    retryCount: 1,
    summary: "Repeated request with same idempotency key → identical result; no duplicate.",
  },
  {
    id: "slow_network",
    title: "Slow network",
    failureCode: "INSUFFICIENT_FUNDS",
    failureClass: "SOFT_RETRYABLE",
    action: "RETRY_NOW",
    pattern: "single",
    summary: "High latency but completes → SUCCEEDED; one debit; client waits.",
  },
  {
    id: "rate_limiting",
    title: "Temporary service overload / rate limiting",
    failureCode: "INSUFFICIENT_FUNDS",
    failureClass: "SOFT_RETRYABLE",
    action: "RECOVER_WHATSAPP",
    pattern: "single",
    summary: "Provider rate-limits → FAILED (no charge); retry allowed with backoff.",
  },
];
