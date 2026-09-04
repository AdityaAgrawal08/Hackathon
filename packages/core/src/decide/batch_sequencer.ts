/**
 * Engagement Telemetry & Intelligent Dynamic EV Priority Batch Sequencer (Phase 3)
 *
 * Replaces unpaced mass-dunning with dynamic Expected Value prioritization:
 *   Priority Score = EV * EngagementVelocity * DomainUrgency * (1.0 - ChurnRisk)
 *
 * Features:
 * 1. Longitudinal behavioral velocity weighting (fast openers dispatched first).
 * 2. Domain urgency weighting (D2C impulse cart urgency vs B2B DSO interest acceleration).
 * 3. TRAI Indian Quiet Hours compliance (21:00-09:00 IST) with dynamic next-morning deferral.
 * 4. Micro-batch rate pacing (configurable batch size and pacing interval to protect provider rate limits).
 * 5. Strict tier categorization: TIER_1_CRITICAL, TIER_2_HIGH, TIER_3_SCHEDULED, TIER_4_SUPPRESSED.
 */

import { paise, formatINR, isoUtc } from "@arbiter/shared";
import type { DomainType } from "../db/schema.js";
import type { PriorityTier } from "../agent/behavioral_profiler.js";

export type { PriorityTier };

// ============================================================================
// Types & Enums
// ============================================================================

export type EngagementStatus =
  | "CLICKED_PORTAL"
  | "OPENED_MESSAGE"
  | "DELIVERED_UNOPENED"
  | "HARD_BOUNCED"
  | "DND_BLOCKED"
  | "FRESH_PENDING";

export const ENGAGEMENT_MULTIPLIERS: Record<EngagementStatus, number> = {
  CLICKED_PORTAL: 2.5,
  OPENED_MESSAGE: 1.5,
  FRESH_PENDING: 1.0,
  DELIVERED_UNOPENED: 0.8,
  HARD_BOUNCED: 0.0,
  DND_BLOCKED: 0.0,
};

/** Classic batch candidate for backward compatibility */
export interface BatchCandidate {
  id: string;
  amountPaise: number;
  pRecovery: number; // 0.0 to 1.0
  costPaise: number;
  engagementStatus: EngagementStatus;
  priorityScore?: number;
  suppressed?: boolean;
}

export interface SequencedBatchResult {
  totalInputCount: number;
  eligibleCount: number;
  suppressedCount: number;
  candidates: BatchCandidate[];
}

/** Enriched enterprise candidate with behavioral signals */
export interface IntelligentBatchCandidate {
  id: string;
  amountPaise: number;
  pRecovery?: number; // 0.0 to 1.0 (default 0.5)
  costPaise?: number; // default 150 paise
  engagementStatus?: EngagementStatus;
  emailOpenLatencyMins?: number | null;
  historicalOpenRate?: number;
  domainType?: DomainType;
  churnRiskBp?: number; // 0 to 10000 bps
  optedOut?: boolean;
  attemptsSoFar?: number;
  maxAttempts?: number; // default 3
  preferredChannel?: "EMAIL" | "SMS" | "AUTO";
  // Evaluated attributes:
  priorityScore?: number;
  priorityTier?: PriorityTier;
  engagementVelocity?: number;
  urgencyWeight?: number;
  retentionFactor?: number;
  suppressed?: boolean;
  suppressionReason?: string;
  deferredUntilMs?: number;
  microBatchIndex?: number;
  scheduledDispatchAtUtc?: string;
}

export interface SequencerConfig {
  maxDispatchesPerBatch?: number; // Default 20
  pacingIntervalMs?: number; // Default 1000ms
  respectQuietHours?: boolean; // Default true
  quietHoursStartIst?: number; // Default 21 (21:00 IST)
  quietHoursEndIst?: number; // Default 9 (09:00 IST)
  domainUrgencyWeights?: Partial<Record<DomainType, number>>;
  tierThresholds?: {
    criticalMinScore?: number; // Default 3000
    highMinScore?: number; // Default 800
  };
}

export interface MicroBatch {
  batchIndex: number;
  candidateIds: string[];
  candidates: IntelligentBatchCandidate[];
  dispatchAtMs: number;
  dispatchAtUtc: string;
  totalBatchPaise: number;
}

export interface IntelligentSequencedResult {
  totalInputCount: number;
  eligibleCount: number;
  suppressedCount: number;
  tierBreakdown: Record<PriorityTier, number>;
  totalExpectedPaise: number;
  totalPotentialSalvagePaise: number;
  microBatches: MicroBatch[];
  candidates: IntelligentBatchCandidate[];
  quietHoursActive: boolean;
  evaluatedAtUtc: string;
}

// ============================================================================
// 1. Classic Backward-Compatible Helpers
// ============================================================================

/**
 * Computes individual candidate EV priority score (classic formula).
 */
export function computeCandidateEV(candidate: BatchCandidate): {
  score: number;
  suppressed: boolean;
} {
  const mult = ENGAGEMENT_MULTIPLIERS[candidate.engagementStatus] ?? 1.0;

  if (mult === 0.0) {
    return { score: 0, suppressed: true };
  }

  const rawExpectedPaise = candidate.amountPaise * candidate.pRecovery - candidate.costPaise;
  const score = Math.max(0, Math.round(rawExpectedPaise * mult));

  return { score, suppressed: false };
}

/**
 * Sequences an array of candidate recovery tasks by descending Expected Value.
 */
export function sequenceBatchByExpectedValue(
  candidates: BatchCandidate[],
): SequencedBatchResult {
  let suppressedCount = 0;

  const evaluated = candidates.map((c) => {
    const { score, suppressed } = computeCandidateEV(c);
    if (suppressed) suppressedCount++;
    return {
      ...c,
      priorityScore: score,
      suppressed,
    };
  });

  evaluated.sort((a, b) => {
    if (a.suppressed && !b.suppressed) return 1;
    if (!a.suppressed && b.suppressed) return -1;
    return (b.priorityScore || 0) - (a.priorityScore || 0);
  });

  return {
    totalInputCount: candidates.length,
    eligibleCount: candidates.length - suppressedCount,
    suppressedCount,
    candidates: evaluated,
  };
}

// ============================================================================
// 2. Intelligent Dynamic Priority Batch Sequencer (Enterprise)
// ============================================================================

/** Check whether given timestamp falls within TRAI Quiet Hours (21:00 - 09:00 IST) */
export function isWithinTRAIQuietHours(
  nowMs: number,
  startHourIst = 21,
  endHourIst = 9,
): { inQuietHours: boolean; resumptionMs: number } {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(nowMs + IST_OFFSET_MS);
  const istHour = istDate.getUTCHours();
  const istMinutes = istDate.getUTCMinutes();

  const inQuietHours = istHour >= startHourIst || istHour < endHourIst;

  const resumptionDate = new Date(istDate);
  if (istHour >= startHourIst) {
    resumptionDate.setUTCDate(resumptionDate.getUTCDate() + 1);
  }
  resumptionDate.setUTCHours(endHourIst, 0, 1, 0); // 09:00:01 IST
  const resumptionMs = resumptionDate.getTime() - IST_OFFSET_MS;

  return { inQuietHours, resumptionMs };
}

/**
 * Evaluates and sequences a recovery batch with dynamic EV, customer engagement velocity,
 * domain urgency, TRAI quiet hours compliance, and rate-pacing micro-batches.
 */
export function sequenceIntelligentRecoveryBatch(
  candidates: IntelligentBatchCandidate[],
  config: SequencerConfig = {},
  nowMs: number = Date.now(),
): IntelligentSequencedResult {
  const maxPerBatch = Math.max(1, config.maxDispatchesPerBatch ?? 20);
  const pacingInterval = Math.max(100, config.pacingIntervalMs ?? 1000);
  const respectQuiet = config.respectQuietHours ?? true;
  const quietStart = config.quietHoursStartIst ?? 21;
  const quietEnd = config.quietHoursEndIst ?? 9;

  const critThreshold = config.tierThresholds?.criticalMinScore ?? 3000;
  const highThreshold = config.tierThresholds?.highMinScore ?? 800;

  const { inQuietHours, resumptionMs } = isWithinTRAIQuietHours(nowMs, quietStart, quietEnd);
  const quietActive = respectQuiet && inQuietHours;

  const tierBreakdown: Record<PriorityTier, number> = {
    TIER_1_CRITICAL: 0,
    TIER_2_HIGH: 0,
    TIER_3_SCHEDULED: 0,
    TIER_4_SUPPRESSED: 0,
  };

  let totalExpectedPaise = 0;
  let totalPotentialSalvagePaise = 0;

  const evaluated: IntelligentBatchCandidate[] = candidates.map((c) => {
    totalPotentialSalvagePaise += c.amountPaise;

    // 1. Suppression Checks
    if (c.optedOut) {
      tierBreakdown.TIER_4_SUPPRESSED++;
      return {
        ...c,
        priorityScore: 0,
        priorityTier: "TIER_4_SUPPRESSED",
        engagementVelocity: 0,
        urgencyWeight: 0,
        retentionFactor: 0,
        suppressed: true,
        suppressionReason: "CUSTOMER_OPT_OUT",
      };
    }

    const maxAtt = c.maxAttempts ?? 3;
    const attSoFar = c.attemptsSoFar ?? 0;
    if (attSoFar >= maxAtt) {
      tierBreakdown.TIER_4_SUPPRESSED++;
      return {
        ...c,
        priorityScore: 0,
        priorityTier: "TIER_4_SUPPRESSED",
        engagementVelocity: 0,
        urgencyWeight: 0,
        retentionFactor: 0,
        suppressed: true,
        suppressionReason: "MAX_ATTEMPTS_EXCEEDED",
      };
    }

    if (c.engagementStatus === "HARD_BOUNCED" || c.engagementStatus === "DND_BLOCKED") {
      tierBreakdown.TIER_4_SUPPRESSED++;
      return {
        ...c,
        priorityScore: 0,
        priorityTier: "TIER_4_SUPPRESSED",
        engagementVelocity: 0,
        urgencyWeight: 0,
        retentionFactor: 0,
        suppressed: true,
        suppressionReason: c.engagementStatus,
      };
    }

    // TRAI Quiet Hours Check
    if (quietActive) {
      tierBreakdown.TIER_4_SUPPRESSED++;
      return {
        ...c,
        priorityScore: 0,
        priorityTier: "TIER_4_SUPPRESSED",
        engagementVelocity: 0,
        urgencyWeight: 0,
        retentionFactor: 0,
        suppressed: true,
        suppressionReason: "TRAI_QUIET_HOURS",
        deferredUntilMs: resumptionMs,
      };
    }

    // 2. Velocity Weight (Dynamic from longitudinal open latency or historical open rate)
    let velocity = 1.0;
    if (typeof c.emailOpenLatencyMins === "number" && !isNaN(c.emailOpenLatencyMins)) {
      if (c.emailOpenLatencyMins <= 15) velocity = 1.6;
      else if (c.emailOpenLatencyMins <= 60) velocity = 1.3;
      else if (c.emailOpenLatencyMins <= 240) velocity = 1.0;
      else velocity = 0.75;
    } else if (c.engagementStatus === "CLICKED_PORTAL") {
      velocity = 2.5;
    } else if (c.engagementStatus === "OPENED_MESSAGE") {
      velocity = 1.5;
    } else if (typeof c.historicalOpenRate === "number") {
      if (c.historicalOpenRate >= 0.6) velocity = 1.3;
      else if (c.historicalOpenRate < 0.15) velocity = 0.7;
    }

    // 3. Domain Urgency Weight
    const domain = c.domainType ?? "D2C_ECOMMERCE";
    const customWeights = config.domainUrgencyWeights ?? {};
    let urgencyWeight = customWeights[domain] ?? 1.0;
    if (customWeights[domain] === undefined) {
      switch (domain) {
        case "D2C_ECOMMERCE":
          urgencyWeight = 1.45;
          break;
        case "B2B_INVOICES":
          urgencyWeight = 1.35;
          break;
        case "SAAS_MANDATES":
          urgencyWeight = 1.15;
          break;
        case "HIGH_TICKET":
          urgencyWeight = 1.0;
          break;
      }
    }

    // 4. Expected Value in Rupees
    const pRec = typeof c.pRecovery === "number" ? Math.max(0, Math.min(1, c.pRecovery)) : 0.5;
    const costP = c.costPaise ?? 150;
    const expectedPaise = Math.round(c.amountPaise * pRec - costP);
    const expectedRupees = Math.max(1, expectedPaise / 100);
    totalExpectedPaise += Math.max(0, expectedPaise);

    // 5. Churn Risk Retention Factor
    const churnBp = c.churnRiskBp ?? 1000;
    const retentionFactor = Math.max(0.1, 1.0 - churnBp / 10000);

    // 6. Dynamic Priority Score
    const rawScore = expectedRupees * velocity * urgencyWeight * retentionFactor;
    const priorityScore = Math.round(rawScore * 100) / 100;

    // 7. Priority Tier
    let priorityTier: PriorityTier = "TIER_3_SCHEDULED";
    if (priorityScore >= critThreshold || (velocity >= 1.5 && expectedRupees >= 1000) || (domain === "D2C_ECOMMERCE" && velocity >= 1.3)) {
      priorityTier = "TIER_1_CRITICAL";
    } else if (priorityScore >= highThreshold || velocity >= 1.2) {
      priorityTier = "TIER_2_HIGH";
    }

    tierBreakdown[priorityTier]++;

    return {
      ...c,
      priorityScore,
      priorityTier,
      engagementVelocity: velocity,
      urgencyWeight,
      retentionFactor,
      suppressed: false,
    };
  });

  // Sort descending by priorityScore with stable tie-break on ID
  evaluated.sort((a, b) => {
    if (a.suppressed && !b.suppressed) return 1;
    if (!a.suppressed && b.suppressed) return -1;
    const scoreDiff = (b.priorityScore ?? 0) - (a.priorityScore ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return a.id.localeCompare(b.id);
  });

  // Partition eligible candidates into micro-batches for rate-limited dispatch
  const microBatches: MicroBatch[] = [];
  const eligible = evaluated.filter((c) => !c.suppressed);

  for (let i = 0; i < eligible.length; i += maxPerBatch) {
    const chunk = eligible.slice(i, i + maxPerBatch);
    const batchIndex = Math.floor(i / maxPerBatch);
    const dispatchAtMs = nowMs + batchIndex * pacingInterval;
    const dispatchAtUtc = isoUtc(dispatchAtMs);

    let batchPaise = 0;
    const ids: string[] = [];

    for (const item of chunk) {
      item.microBatchIndex = batchIndex;
      item.scheduledDispatchAtUtc = dispatchAtUtc;
      batchPaise += item.amountPaise;
      ids.push(item.id);
    }

    microBatches.push({
      batchIndex,
      candidateIds: ids,
      candidates: chunk,
      dispatchAtMs,
      dispatchAtUtc,
      totalBatchPaise: batchPaise,
    });
  }

  const suppressedCount = evaluated.filter((c) => c.suppressed).length;

  return {
    totalInputCount: candidates.length,
    eligibleCount: eligible.length,
    suppressedCount,
    tierBreakdown,
    totalExpectedPaise,
    totalPotentialSalvagePaise,
    microBatches,
    candidates: evaluated,
    quietHoursActive: quietActive,
    evaluatedAtUtc: isoUtc(nowMs),
  };
}
