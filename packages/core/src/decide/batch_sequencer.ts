/**
 * Engagement Telemetry & EV Batch Priority Sequencer (Task 6.10 / ENG-11)
 *
 * Replaces unpaced mass-dunning with dynamic Expected Value prioritization:
 *   Priority Score = (P(recovery) * Amount - ChannelCost) * EngagementMultiplier
 *
 * Suppresses bounced/DND candidates permanently and fast-tracks high-intent clicks.
 */
import { paise } from "@arbiter/shared";

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

/**
 * Computes individual candidate EV priority score.
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

  // Sort descending by priorityScore (unsuppressed first, highest EV at top)
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
