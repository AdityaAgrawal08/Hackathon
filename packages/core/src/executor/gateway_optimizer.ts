/**
 * Razorpay Optimizer Tier-0 In-Flight Gateway Cascade Engine (Task 7.2 / OPT-17)
 *
 * Emulates enterprise Razorpay Optimizer multi-gateway cascading to resolve
 * technical acquirer errors (ISO 91/96, HTTP 504 Gateway Timeout) in-flight (<1.8s)
 * before declaring a payment failure or disturbing the customer.
 */
import { formatINR, paise } from "@arbiter/shared";

export type AcquirerGatewayId =
  | "HDFC_SMARTGATEWAY"
  | "AXIS_PG"
  | "ICICI_PAYSEAL"
  | "RAZORPAY_STANDARD";

export const DEFAULT_CASCADE_SEQUENCE: readonly AcquirerGatewayId[] = [
  "HDFC_SMARTGATEWAY",
  "AXIS_PG",
  "ICICI_PAYSEAL",
] as const;

export const TECHNICAL_CASCADE_ERROR_CODES = new Set([
  "GATEWAY_ERROR",
  "GATEWAY_TIMEOUT",
  "ACQUIRER_TIMEOUT",
  "BANK_SWITCH_DOWN",
  "NETWORK_ERROR",
  "ISSUER_DOWN",
  "ISO_8583_91", // Issuer switch inoperative
  "ISO_8583_96", // System malfunction
  "HTTP_504_GATEWAY_TIMEOUT",
  "BAD_GATEWAY",
  "504",
  "502",
]);

export interface CascadeHop {
  gatewayId: AcquirerGatewayId;
  attemptNumber: number;
  status: "SUCCESS" | "FAILED";
  errorCode?: string;
  latencyMs: number;
}

export interface CascadeInput {
  orderId: string;
  amountPaise: number;
  initialErrorCode: string;
  idempotencyKey: string;
  cascadeSequence?: readonly AcquirerGatewayId[];
  /** Optional deterministic mock outcomes for simulation and testing */
  mockGatewayOutcomes?: Partial<Record<AcquirerGatewayId, { success: boolean; errorCode?: string; latencyMs?: number }>>;
}

export interface GatewayCascadeResult {
  recoveredInFlight: boolean;
  finalStatus: "CAPTURED" | "HANDOFF_TO_DUNNING";
  winningGateway?: AcquirerGatewayId;
  hops: CascadeHop[];
  totalLatencyMs: number;
  cogsSavedPaise: number;
  orderId: string;
  amountPaise: number;
  reason: string;
}

/**
 * Checks whether an error code represents an upstream technical/gateway failure
 * eligible for an in-flight auto-cascade.
 */
export function isCascadeEligible(errorCode: string): boolean {
  if (!errorCode) return false;
  const upper = errorCode.toUpperCase().trim();
  return TECHNICAL_CASCADE_ERROR_CODES.has(upper) ||
    upper.includes("TIMEOUT") ||
    upper.includes("SWITCH_DOWN") ||
    upper.includes("504") ||
    upper.includes("502");
}

export class GatewayOptimizer {
  private metrics = {
    totalRouted: 0,
    inFlightRecovered: 0,
    handoffToDunning: 0,
    totalCogsSavedPaise: 0,
    cumulativeLatencyMs: 0,
  };

  /**
   * Executes the multi-gateway in-flight routing cascade.
   */
  executeCascade(input: CascadeInput): GatewayCascadeResult {
    const sequence = input.cascadeSequence || DEFAULT_CASCADE_SEQUENCE;
    const isTechnical = isCascadeEligible(input.initialErrorCode);

    this.metrics.totalRouted++;

    // If failure is customer-side (e.g. INSUFFICIENT_FUNDS, CARD_EXPIRED),
    // cascading gateways won't help. Handoff immediately to customer dunning.
    if (!isTechnical) {
      this.metrics.handoffToDunning++;
      return {
        recoveredInFlight: false,
        finalStatus: "HANDOFF_TO_DUNNING",
        hops: [
          {
            gatewayId: sequence[0]!,
            attemptNumber: 1,
            status: "FAILED",
            errorCode: input.initialErrorCode,
            latencyMs: 120,
          },
        ],
        totalLatencyMs: 120,
        cogsSavedPaise: 0,
        orderId: input.orderId,
        amountPaise: input.amountPaise,
        reason: `Failure code '${input.initialErrorCode}' is a consumer-side decline; in-flight cascade bypassed. Handing off to ARBITER dunning.`,
      };
    }

    const hops: CascadeHop[] = [];
    let totalLatency = 0;
    const maxLatencyBudgetMs = 2500;

    // Hop 1: Primary gateway failed with technical error
    hops.push({
      gatewayId: sequence[0]!,
      attemptNumber: 1,
      status: "FAILED",
      errorCode: input.initialErrorCode,
      latencyMs: 380,
    });
    totalLatency += 380;

    // Subsequent Hops: Auto-failover across fallback acquirers
    for (let i = 1; i < sequence.length; i++) {
      const gatewayId = sequence[i]!;

      // Check latency budget ceiling
      if (totalLatency >= maxLatencyBudgetMs) {
        break;
      }

      const mock = input.mockGatewayOutcomes?.[gatewayId];
      // By default in simulation, secondary gateway succeeds if primary was technical timeout
      const isSuccess = mock ? mock.success : i === 1; // Secondary succeeds by default
      const hopLatency = mock?.latencyMs ?? (isSuccess ? 620 : 750);
      totalLatency += hopLatency;

      if (isSuccess) {
        hops.push({
          gatewayId,
          attemptNumber: i + 1,
          status: "SUCCESS",
          latencyMs: hopLatency,
        });

        // 18 paise (SMS) + 45 paise (WhatsApp) = 63 paise saved by not dispatching dunning
        const cogsSaved = 63;
        this.metrics.inFlightRecovered++;
        this.metrics.totalCogsSavedPaise += cogsSaved;
        this.metrics.cumulativeLatencyMs += totalLatency;

        return {
          recoveredInFlight: true,
          finalStatus: "CAPTURED",
          winningGateway: gatewayId,
          hops,
          totalLatencyMs: totalLatency,
          cogsSavedPaise: cogsSaved,
          orderId: input.orderId,
          amountPaise: input.amountPaise,
          reason: `Primary gateway '${sequence[0]}' encountered '${input.initialErrorCode}'. Auto-cascaded in-flight to '${gatewayId}' in ${totalLatency}ms. Captured with ₹0 customer dunning cost.`,
        };
      } else {
        hops.push({
          gatewayId,
          attemptNumber: i + 1,
          status: "FAILED",
          errorCode: mock?.errorCode ?? "GATEWAY_TIMEOUT",
          latencyMs: hopLatency,
        });
      }
    }

    // If all acquirers in cascade failed:
    this.metrics.handoffToDunning++;
    this.metrics.cumulativeLatencyMs += totalLatency;

    return {
      recoveredInFlight: false,
      finalStatus: "HANDOFF_TO_DUNNING",
      hops,
      totalLatencyMs: totalLatency,
      cogsSavedPaise: 0,
      orderId: input.orderId,
      amountPaise: input.amountPaise,
      reason: `All ${sequence.length} acquirer gateways in cascade sequence failed. In-flight recovery exhausted. Handing off to ARBITER customer recovery.`,
    };
  }

  /**
   * Returns telemetry metrics for the Optimizer cascade engine.
   */
  getMetrics() {
    const avgLatency =
      this.metrics.totalRouted > 0
        ? Math.round(this.metrics.cumulativeLatencyMs / Math.max(1, this.metrics.inFlightRecovered + this.metrics.handoffToDunning))
        : 0;

    const recoveryRatePct =
      this.metrics.totalRouted > 0
        ? Number(((this.metrics.inFlightRecovered / this.metrics.totalRouted) * 100).toFixed(1))
        : 0;

    return {
      totalRouted: this.metrics.totalRouted,
      inFlightRecovered: this.metrics.inFlightRecovered,
      handoffToDunning: this.metrics.handoffToDunning,
      recoveryRatePct,
      totalCogsSavedPaise: this.metrics.totalCogsSavedPaise,
      totalCogsSavedFormatted: formatINR(paise(this.metrics.totalCogsSavedPaise)),
      averageLatencyMs: avgLatency,
    };
  }

  /**
   * Resets metrics (used for testing).
   */
  resetMetrics() {
    this.metrics = {
      totalRouted: 0,
      inFlightRecovered: 0,
      handoffToDunning: 0,
      totalCogsSavedPaise: 0,
      cumulativeLatencyMs: 0,
    };
  }
}

export const defaultGatewayOptimizer = new GatewayOptimizer();
