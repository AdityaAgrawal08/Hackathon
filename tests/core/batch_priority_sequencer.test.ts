/**
 * Comprehensive Unit Test Suite for Task 3.2: Intelligent Priority Batch Sequencer
 * Validates dynamic EV scoring, longitudinal velocity weighting, TRAI quiet hours compliance,
 * and rate-pacing micro-batches.
 */

import { describe, it, expect } from "vitest";
import {
  sequenceIntelligentRecoveryBatch,
  isWithinTRAIQuietHours,
  type IntelligentBatchCandidate,
} from "../../packages/core/src/decide/batch_sequencer.js";

describe("Phase 3: Intelligent Priority Batch Sequencer", () => {
  // Reference timestamps:
  // Daytime: 14:00 IST (08:30 UTC) -> outside quiet hours
  const DAYTIME_MS = new Date("2026-09-04T08:30:00.000Z").getTime();
  // Nighttime: 23:30 IST (18:00 UTC) -> inside quiet hours (21:00-09:00 IST)
  const NIGHTTIME_MS = new Date("2026-09-04T18:00:00.000Z").getTime();

  describe("1. Velocity & Behavioral Priority Scoring", () => {
    it("prioritizes rapid openers over delayed openers with identical amounts", () => {
      const candidates: IntelligentBatchCandidate[] = [
        {
          id: "cand_slow_opener",
          amountPaise: 299900,
          emailOpenLatencyMins: 360, // 6 hours latency -> velocity 0.75
          domainType: "D2C_ECOMMERCE",
        },
        {
          id: "cand_rapid_opener",
          amountPaise: 299900,
          emailOpenLatencyMins: 4, // 4 mins latency -> velocity 1.6
          domainType: "D2C_ECOMMERCE",
        },
        {
          id: "cand_moderate_opener",
          amountPaise: 299900,
          emailOpenLatencyMins: 45, // 45 mins latency -> velocity 1.3
          domainType: "D2C_ECOMMERCE",
        },
      ];

      const res = sequenceIntelligentRecoveryBatch(candidates, { respectQuietHours: false }, DAYTIME_MS);

      expect(res.eligibleCount).toBe(3);
      expect(res.suppressedCount).toBe(0);

      // Top candidate must be the rapid opener
      expect(res.candidates[0].id).toBe("cand_rapid_opener");
      expect(res.candidates[0].priorityTier).toBe("TIER_1_CRITICAL");
      expect(res.candidates[0].engagementVelocity).toBe(1.6);

      // 2nd must be moderate opener
      expect(res.candidates[1].id).toBe("cand_moderate_opener");
      expect(res.candidates[1].engagementVelocity).toBe(1.3);

      // 3rd must be slow opener
      expect(res.candidates[2].id).toBe("cand_slow_opener");
      expect(res.candidates[2].engagementVelocity).toBe(0.75);

      expect(res.candidates[0].priorityScore).toBeGreaterThan(res.candidates[1].priorityScore!);
      expect(res.candidates[1].priorityScore).toBeGreaterThan(res.candidates[2].priorityScore!);
    });

    it("applies domain urgency weights correctly", () => {
      const candidates: IntelligentBatchCandidate[] = [
        {
          id: "cand_edtech",
          amountPaise: 100000,
          domainType: "HIGH_TICKET", // urgency 1.0
        },
        {
          id: "cand_d2c",
          amountPaise: 100000,
          domainType: "D2C_ECOMMERCE", // urgency 1.45
        },
        {
          id: "cand_b2b",
          amountPaise: 100000,
          domainType: "B2B_INVOICES", // urgency 1.35
        },
      ];

      const res = sequenceIntelligentRecoveryBatch(candidates, { respectQuietHours: false }, DAYTIME_MS);

      expect(res.candidates[0].id).toBe("cand_d2c");
      expect(res.candidates[1].id).toBe("cand_b2b");
      expect(res.candidates[2].id).toBe("cand_edtech");
    });
  });

  describe("2. TRAI Indian Quiet Hours Compliance", () => {
    it("detects quiet hours accurately in IST", () => {
      const daytimeCheck = isWithinTRAIQuietHours(DAYTIME_MS);
      expect(daytimeCheck.inQuietHours).toBe(false);

      const nighttimeCheck = isWithinTRAIQuietHours(NIGHTTIME_MS);
      expect(nighttimeCheck.inQuietHours).toBe(true);

      // Verify resumption is next morning at 09:00:01 IST
      const resumptionDateIST = new Date(nighttimeCheck.resumptionMs + 5.5 * 3600000);
      expect(resumptionDateIST.getUTCHours()).toBe(9);
      expect(resumptionDateIST.getUTCMinutes()).toBe(0);
      expect(resumptionDateIST.getUTCSeconds()).toBe(1);
    });

    it("suppresses all outreach during TRAI quiet hours and defers to 09:00 IST", () => {
      const candidates: IntelligentBatchCandidate[] = [
        { id: "cand_1", amountPaise: 500000, domainType: "D2C_ECOMMERCE" },
        { id: "cand_2", amountPaise: 200000, domainType: "SAAS_MANDATES" },
      ];

      const res = sequenceIntelligentRecoveryBatch(candidates, { respectQuietHours: true }, NIGHTTIME_MS);

      expect(res.quietHoursActive).toBe(true);
      expect(res.suppressedCount).toBe(2);
      expect(res.eligibleCount).toBe(0);
      expect(res.tierBreakdown.TIER_4_SUPPRESSED).toBe(2);

      for (const cand of res.candidates) {
        expect(cand.suppressed).toBe(true);
        expect(cand.suppressionReason).toBe("TRAI_QUIET_HOURS");
        expect(cand.priorityTier).toBe("TIER_4_SUPPRESSED");
        expect(cand.deferredUntilMs).toBeDefined();
        expect(cand.deferredUntilMs).toBeGreaterThan(NIGHTTIME_MS);
      }
    });
  });

  describe("3. Suppression & Policy Caps", () => {
    it("suppresses opted-out customers, max attempts exceeded, and bounced channels", () => {
      const candidates: IntelligentBatchCandidate[] = [
        { id: "c_opted_out", amountPaise: 100000, optedOut: true },
        { id: "c_max_attempts", amountPaise: 100000, attemptsSoFar: 3, maxAttempts: 3 },
        { id: "c_bounced", amountPaise: 100000, engagementStatus: "HARD_BOUNCED" },
        { id: "c_valid", amountPaise: 100000, attemptsSoFar: 0, maxAttempts: 3 },
      ];

      const res = sequenceIntelligentRecoveryBatch(candidates, { respectQuietHours: false }, DAYTIME_MS);

      expect(res.totalInputCount).toBe(4);
      expect(res.eligibleCount).toBe(1);
      expect(res.suppressedCount).toBe(3);

      const validCand = res.candidates.find((c) => c.id === "c_valid");
      expect(validCand?.suppressed).toBe(false);

      const optedOutCand = res.candidates.find((c) => c.id === "c_opted_out");
      expect(optedOutCand?.suppressionReason).toBe("CUSTOMER_OPT_OUT");

      const maxAttCand = res.candidates.find((c) => c.id === "c_max_attempts");
      expect(maxAttCand?.suppressionReason).toBe("MAX_ATTEMPTS_EXCEEDED");
    });
  });

  describe("4. Micro-Batch Rate Pacing", () => {
    it("partitions eligible candidates into rate-paced micro-batches", () => {
      // 25 eligible candidates
      const candidates: IntelligentBatchCandidate[] = Array.from({ length: 25 }, (_, i) => ({
        id: `c_${i + 1}`,
        amountPaise: (i + 1) * 10000,
        domainType: "D2C_ECOMMERCE",
      }));

      const res = sequenceIntelligentRecoveryBatch(
        candidates,
        {
          respectQuietHours: false,
          maxDispatchesPerBatch: 10, // 10 per batch -> 3 batches (10, 10, 5)
          pacingIntervalMs: 1500, // 1.5s delay
        },
        DAYTIME_MS
      );

      expect(res.eligibleCount).toBe(25);
      expect(res.microBatches.length).toBe(3);

      // Batch 0: 10 candidates, dispatch now
      expect(res.microBatches[0].candidates.length).toBe(10);
      expect(res.microBatches[0].dispatchAtMs).toBe(DAYTIME_MS);

      // Batch 1: 10 candidates, dispatch +1.5s
      expect(res.microBatches[1].candidates.length).toBe(10);
      expect(res.microBatches[1].dispatchAtMs).toBe(DAYTIME_MS + 1500);

      // Batch 2: 5 candidates, dispatch +3.0s
      expect(res.microBatches[2].candidates.length).toBe(5);
      expect(res.microBatches[2].dispatchAtMs).toBe(DAYTIME_MS + 3000);
    });
  });
});
