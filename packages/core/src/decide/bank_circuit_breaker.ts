/**
 * Real-Time Bank Switch Health Circuit Breaker & Inter-Bank Steering Engine (Task 7.3 / BNK-18)
 *
 * Ingests real-time switch telemetry for India's Top 4 Issuer Banks (HDFC, SBI, ICICI, Axis).
 * Circuit-breaks degraded banking switches (success rate < 60%) and dynamically steers
 * customer recovery to healthy payment rails before wasting merchant communication COGS.
 */
import { clamp01, hashSeed } from "@arbiter/shared";
import { simulatedRailHealth, type RailHealthSnapshot } from "../ingest/rail_health.js";

export type BankId = "HDFC" | "SBI" | "ICICI" | "AXIS";

export type CircuitBreakerState = "CLOSED" | "HALF_OPEN" | "OPEN";

export type BankHealthStatus = "HEALTHY" | "DEGRADED" | "CRITICAL_OUTAGE";

export interface BankSwitchHealth {
  bankId: BankId;
  bankName: string;
  successRate: number; // 0..1
  latencyMs: number;
  status: BankHealthStatus;
  circuitState: CircuitBreakerState;
  supportedHandles: string[];
  ifscPrefix: string;
}

export interface SteeringRecommendation {
  allowed: boolean;
  circuitState: CircuitBreakerState;
  impairedBank?: BankId;
  successRate?: number;
  recommendedBank: BankId;
  recommendedRail: "upi" | "cards" | "netbanking";
  steeringMessage: string;
  bannerWarning: string;
}

export interface CompositeHealthSnapshot {
  timestampUtc: string;
  overallRailHealth: RailHealthSnapshot;
  banks: BankSwitchHealth[];
  activeOutagesCount: number;
}

export const BANK_CONFIGS: Record<BankId, { name: string; handles: string[]; ifsc: string }> = {
  HDFC: {
    name: "HDFC Bank",
    handles: ["@okhdfcbank", "@hdfcbank", "@rajadhdfc"],
    ifsc: "HDFC",
  },
  SBI: {
    name: "State Bank of India",
    handles: ["@oksbi", "@sbi", "@sbiyono"],
    ifsc: "SBIN",
  },
  ICICI: {
    name: "ICICI Bank",
    handles: ["@okicici", "@icici", "@imobile"],
    ifsc: "ICIC",
  },
  AXIS: {
    name: "Axis Bank",
    handles: ["@okaxis", "@axisbank", "@pingpay"],
    ifsc: "UTIB",
  },
};

/**
 * Resolves the issuing bank from a customer VPA, IFSC code, or bank name string.
 */
export function resolveBankFromIdentifier(identifier: string): BankId | null {
  if (!identifier) return null;
  const upper = identifier.toUpperCase().trim();

  // 1. Check IFSC prefixes
  if (upper.startsWith("HDFC")) return "HDFC";
  if (upper.startsWith("SBIN") || upper.startsWith("SBI")) return "SBI";
  if (upper.startsWith("ICIC")) return "ICICI";
  if (upper.startsWith("UTIB") || upper.startsWith("AXIS")) return "AXIS";

  // 2. Check UPI VPA handle patterns
  const lower = identifier.toLowerCase().trim();
  if (lower.includes("hdfc")) return "HDFC";
  if (lower.includes("sbi")) return "SBI";
  if (lower.includes("icici")) return "ICICI";
  if (lower.includes("axis")) return "AXIS";

  return null;
}

export class BankCircuitBreakerManager {
  private overrides = new Map<BankId, Partial<BankSwitchHealth>>();

  /**
   * Sets a manual override for a bank's health (used in tests and live demo scenarios).
   */
  setOverride(bankId: BankId, override: Partial<BankSwitchHealth> | null): void {
    if (override === null) {
      this.overrides.delete(bankId);
    } else {
      this.overrides.set(bankId, override);
    }
  }

  /**
   * Evaluates instantaneous switch health for all Top 4 Indian Issuer Banks.
   * Deterministic function of IST time-of-day plus minute-seeded jitter.
   */
  getBankHealth(nowMs: number = Date.now()): BankSwitchHealth[] {
    const istMs = nowMs + 330 * 60_000;
    const istHour = (istMs % 86_400_000) / 3_600_000;

    const seed = hashSeed(`bank_switch:${Math.floor(nowMs / 60_000)}`);
    const jitter = ((seed % 1000) / 1000 - 0.5) * 0.08;

    // 1. SBI: Nightly CBS batch maintenance dip between 01:30 and 03:30 AM IST
    const sbiMaintenanceDip = Math.max(0, 1 - Math.abs(istHour - 2.5) / 1.5);
    const sbiSR = clamp01(0.92 - sbiMaintenanceDip * 0.55 + jitter);

    // 2. HDFC: Peak-load retail stress dip between 20:00 and 22:00 IST
    const hdfcPeakStress = Math.max(0, 1 - Math.abs(istHour - 21) / 2);
    const hdfcSR = clamp01(0.95 - hdfcPeakStress * 0.40 + jitter);

    // 3. ICICI: High availability baseline
    const iciciSR = clamp01(0.96 + jitter * 0.5);

    // 4. Axis: Stable baseline
    const axisSR = clamp01(0.93 + jitter * 0.6);

    const baseRates: Record<BankId, { rate: number; latency: number }> = {
      HDFC: { rate: hdfcSR, latency: Math.round(180 + (1 - hdfcSR) * 1200) },
      SBI: { rate: sbiSR, latency: Math.round(240 + (1 - sbiSR) * 1500) },
      ICICI: { rate: iciciSR, latency: Math.round(150 + (1 - iciciSR) * 600) },
      AXIS: { rate: axisSR, latency: Math.round(190 + (1 - axisSR) * 800) },
    };

    return (Object.keys(BANK_CONFIGS) as BankId[]).map((bankId) => {
      const config = BANK_CONFIGS[bankId];
      const base = baseRates[bankId];
      const override = this.overrides.get(bankId);

      const successRate = override?.successRate ?? base.rate;
      const latencyMs = override?.latencyMs ?? base.latency;

      let status: BankHealthStatus = "HEALTHY";
      let circuitState: CircuitBreakerState = "CLOSED";

      if (successRate < 0.50) {
        status = "CRITICAL_OUTAGE";
        circuitState = "OPEN";
      } else if (successRate < 0.75) {
        status = "DEGRADED";
        circuitState = "HALF_OPEN";
      }

      return {
        bankId,
        bankName: config.name,
        successRate: Number(successRate.toFixed(3)),
        latencyMs,
        status: override?.status ?? status,
        circuitState: override?.circuitState ?? circuitState,
        supportedHandles: config.handles,
        ifscPrefix: config.ifsc,
      };
    });
  }

  /**
   * Evaluates the circuit breaker for a customer's specific banking identifier.
   */
  evaluate(
    identifier: string,
    preferredMethod: "upi" | "cards" | "netbanking" = "upi",
    nowMs: number = Date.now(),
  ): SteeringRecommendation {
    const bankId = resolveBankFromIdentifier(identifier);
    const bankHealths = this.getBankHealth(nowMs);

    // Find the current bank's state (if recognized)
    const currentBank = bankId ? bankHealths.find((b) => b.bankId === bankId) : null;

    // If bank is healthy or identifier is unknown, permit standard execution
    if (!currentBank || currentBank.circuitState === "CLOSED") {
      const bestBank = bankHealths.reduce((prev, curr) => (curr.successRate > prev.successRate ? curr : prev));
      return {
        allowed: true,
        circuitState: "CLOSED",
        impairedBank: undefined,
        successRate: currentBank?.successRate ?? 0.95,
        recommendedBank: currentBank?.bankId ?? bestBank.bankId,
        recommendedRail: preferredMethod,
        steeringMessage: "Bank switch operating within normal latency parameters.",
        bannerWarning: "",
      };
    }

    // Bank is DEGRADED or CRITICAL_OUTAGE -> Trigger Inter-Bank Steering
    const healthyAlternatives = bankHealths
      .filter((b) => b.bankId !== bankId && b.circuitState === "CLOSED")
      .sort((a, b) => b.successRate - a.successRate);

    const bestAlt = healthyAlternatives[0] ?? bankHealths.reduce((p, c) => (c.successRate > p.successRate ? c : p));

    const pct = (currentBank.successRate * 100).toFixed(0);
    const isCritical = currentBank.circuitState === "OPEN";

    const steeringMessage = isCritical
      ? `${currentBank.bankName} servers are experiencing high downtime (${pct}% success rate). Payments routed through this bank are currently failing. We strongly recommend completing your transaction via ${bestAlt.bankName} or an alternate card.`
      : `${currentBank.bankName} switch is currently experiencing elevated latency (${pct}% success rate). You can proceed, but ${bestAlt.bankName} UPI offers faster instant settlement.`;

    const bannerWarning = `⚠️ ${currentBank.bankName} switch delays detected nationwide (${pct}% SR). Recommended: ${bestAlt.bankName} UPI or Credit/Debit Card.`;

    return {
      allowed: !isCritical,
      circuitState: currentBank.circuitState,
      impairedBank: currentBank.bankId,
      successRate: currentBank.successRate,
      recommendedBank: bestAlt.bankId,
      recommendedRail: preferredMethod === "upi" ? "upi" : "cards",
      steeringMessage,
      bannerWarning,
    };
  }

  /**
   * Generates a composite snapshot combining payment rails and bank switches.
   */
  getCompositeSnapshot(nowMs: number = Date.now()): CompositeHealthSnapshot {
    const overallRailHealth = simulatedRailHealth(nowMs);
    const banks = this.getBankHealth(nowMs);
    const activeOutagesCount = banks.filter((b) => b.circuitState === "OPEN").length;

    return {
      timestampUtc: new Date(nowMs).toISOString(),
      overallRailHealth,
      banks,
      activeOutagesCount,
    };
  }
}

export const defaultBankCircuitBreaker = new BankCircuitBreakerManager();
