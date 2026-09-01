/**
 * Control arm — pluggable interface for batch benchmark comparison.
 *
 * Extracted from recovery.ts (C-003). Defines a `ControlArm` interface that
 * enables injectable, testable control strategies. The `HistoricalBaseline`
 * implementation uses fixed historical recovery rates per failure class,
 * representing natural self-recovery WITHOUT any intervention (no model
 * dependency — bug #A-002 fix).
 *
 * Uses a hash of the event ID for reproducibility — no RNG.
 */
import { hashSeed } from "@arbiter/shared";

/**
 * Pluggable control arm interface. Any implementation answers:
 * "Given this event, would it have recovered WITHOUT ARBITER?"
 */
export interface ControlArm {
  /** Human-readable name for this control strategy. */
  readonly name: string;
  /** Fixed historical baseline rates per failure class. */
  readonly rates: Record<string, number>;
  /**
   * Determine whether this event would have succeeded without intervention.
   * @param eventId - unique event identifier
   * @param failureClass - classified failure class (SOFT_RETRYABLE, etc.)
   * @returns "SUCCEEDED" or "FAILED"
   */
  outcome(eventId: string, failureClass: string): "SUCCEEDED" | "FAILED";
}

/**
 * Historical baseline: fixed recovery rates per failure class.
 * This is the simplest control arm — no model, no timing, just historical rates.
 */
export class HistoricalBaseline implements ControlArm {
  readonly name = "historical_baseline";

  readonly rates: Record<string, number> = {
    SOFT_RETRYABLE: 0.20,   // ~20% self-recover on next attempt
    NETWORK_TIMEOUT: 0.30,  // ~30% transient, resolves on retry
    HARD_METHOD_DEAD: 0.02, // ~2% nearly zero without method change
    RISK_FLAGGED: 0.01,     // ~1% almost never recovers without review
  };

  outcome(eventId: string, failureClass: string): "SUCCEEDED" | "FAILED" {
    const rate = this.rates[failureClass] ?? 0.15;
    const draw = hashSeed(eventId + "|control") % 10_000;
    return draw < Math.round(rate * 10_000) ? "SUCCEEDED" : "FAILED";
  }
}

/** Default rates constant for backward-compatible direct usage. */
export const CONTROL_RATES: Record<string, number> = {
  SOFT_RETRYABLE: 0.20,
  NETWORK_TIMEOUT: 0.30,
  HARD_METHOD_DEAD: 0.02,
  RISK_FLAGGED: 0.01,
};

/**
 * Deterministic control-arm outcome: what would happen with NO intervention.
 * @param eventId - unique event identifier
 * @param failureCode - Razorpay error code (used to look up baseline rate)
 * @returns "SUCCEEDED" or "FAILED" based on deterministic hash
 */
export function controlOutcome(
  eventId: string,
  failureCode: string,
): "SUCCEEDED" | "FAILED" {
  const rate = CONTROL_RATES[failureCode] ?? 0.15;
  const draw = hashSeed(eventId + "|control") % 10_000;
  return draw < Math.round(rate * 10_000) ? "SUCCEEDED" : "FAILED";
}
