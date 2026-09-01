/**
 * Provider abstraction for executing recovery actions.
 * Enables real Razorpay integration (dry-run or live) vs. deterministic simulation.
 */
export type ExecutionOutcome = "SUCCEEDED" | "FAILED" | "AMBIGUOUS";

export interface ProviderContext {
  proposalId: string;
  actionId: string;
  failureClass: string;
  amountPaise: number;
  evPaise: number;
  tenantId: string;
  rzpRequestRef: string;
  idempotencyKey: string;
  nowMs: number;
  /** Customer profile data — optional so dry-run/tests can omit it. */
  customer?: {
    name?: string;
    phone?: string;
    email?: string;
  };
}

export interface ProviderResult {
  outcome: ExecutionOutcome;
  /** In dry-run mode: the payload that WOULD have been sent to Razorpay. */
  dryRunPayload?: unknown;
  /** In live mode: the real Razorpay response reference. */
  rzpResponseRef?: string;
}

export interface ActionProvider {
  /** Provider identifier for logging/auditing. */
  readonly name: string;
  /** Execute the action. In dry-run mode, returns payload + mock outcome. */
  execute(ctx: ProviderContext): Promise<ProviderResult>;
  /** Whether this provider makes real network calls. */
  readonly isLive: boolean;
}