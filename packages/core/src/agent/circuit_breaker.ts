/**
 * Bank Downtime Circuit Breaker (Track 3)
 *
 * Monitors real-time failure error codes from Indian payment rails (NPCI UPI, SBI, HDFC, ICICI, etc.).
 * When a major banking rail experiences a total outage, this circuit breaker trips to OPEN,
 * queueing customer outreach rather than burning customer touch limits with links that will fail.
 *
 * States:
 * - CLOSED: Rail healthy, outreach dispatches immediately.
 * - OPEN: Rail experiencing downtime outage, outreach is queued.
 * - HALF_OPEN: Probing rail health with canary traffic before full recovery.
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitRailHealth {
  rail: string;
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureTimeMs: number;
  lastSuccessTimeMs: number;
  cooldownPeriodMs: number;
  trippedCount: number;
}

export interface CircuitBreakerConfig {
  failureThreshold: number; // Consecutive failures to trip (default: 5)
  windowMs: number; // Sliding window duration (default: 5 mins)
  cooldownPeriodMs: number; // Duration to remain OPEN before probing HALF_OPEN (default: 2 mins)
}

export const KNOWN_BANK_OUTAGE_CODES = new Set([
  "BANK_DOWNTIME",
  "BANK_DOWNTIME_NETWORK_ERROR",
  "NPCI_UNAVAILABLE",
  "ACQUIRER_TIMEOUT",
  "INTERNAL_SERVER_ERROR",
  "GATEWAY_TIMEOUT",
  "BAD_REQUEST_PAYMENT_TIMED_OUT",
  "ISSUING_BANK_DOWN",
]);

export class OutageCircuitBreaker {
  private rails = new Map<string, CircuitRailHealth>();
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      windowMs: config.windowMs ?? 300_000, // 5 mins
      cooldownPeriodMs: config.cooldownPeriodMs ?? 120_000, // 2 mins
    };
  }

  private getOrCreateRail(railName: string): CircuitRailHealth {
    const key = (railName || "GENERAL_GATEWAY").toUpperCase();
    if (!this.rails.has(key)) {
      this.rails.set(key, {
        rail: key,
        state: "CLOSED",
        consecutiveFailures: 0,
        lastFailureTimeMs: 0,
        lastSuccessTimeMs: Date.now(),
        cooldownPeriodMs: this.config.cooldownPeriodMs,
        trippedCount: 0,
      });
    }
    return this.rails.get(key)!;
  }

  /**
   * Evaluates whether outreach for this bank rail can proceed.
   */
  canDispatch(railName: string, nowMs: number = Date.now()): { allowed: boolean; state: CircuitState; reason?: string } {
    const rail = this.getOrCreateRail(railName);

    if (rail.state === "OPEN") {
      if (nowMs - rail.lastFailureTimeMs >= rail.cooldownPeriodMs) {
        rail.state = "HALF_OPEN";
        return { allowed: true, state: "HALF_OPEN", reason: `Rail ${rail.rail} entered HALF_OPEN canary probe.` };
      }
      return {
        allowed: false,
        state: "OPEN",
        reason: `Rail ${rail.rail} is OPEN due to active banking downtime outage (${rail.consecutiveFailures} consecutive errors). Outreach queued.`,
      };
    }

    return { allowed: true, state: rail.state };
  }

  /**
   * Records transaction outcome against rail health.
   */
  recordOutcome(railName: string, isFailure: boolean, failureCode?: string, nowMs: number = Date.now()): CircuitState {
    const rail = this.getOrCreateRail(railName);
    const isOutageCode = failureCode ? KNOWN_BANK_OUTAGE_CODES.has(failureCode.toUpperCase()) : false;

    if (isFailure && isOutageCode) {
      rail.consecutiveFailures++;
      rail.lastFailureTimeMs = nowMs;

      if (rail.state === "CLOSED" && rail.consecutiveFailures >= this.config.failureThreshold) {
        rail.state = "OPEN";
        rail.trippedCount++;
      } else if (rail.state === "HALF_OPEN") {
        rail.state = "OPEN";
      }
    } else if (!isFailure) {
      rail.consecutiveFailures = 0;
      rail.lastSuccessTimeMs = nowMs;
      rail.state = "CLOSED";
    }

    return rail.state;
  }

  /**
   * Returns current snapshot of all monitored rails.
   */
  getStatus(): Record<string, CircuitRailHealth> {
    const snapshot: Record<string, CircuitRailHealth> = {};
    for (const [key, val] of this.rails.entries()) {
      snapshot[key] = { ...val };
    }
    return snapshot;
  }

  /**
   * Resets all circuit states (for test teardowns or manual administrative recovery).
   */
  reset(): void {
    this.rails.clear();
  }
}

export const defaultOutageCircuitBreaker = new OutageCircuitBreaker();
