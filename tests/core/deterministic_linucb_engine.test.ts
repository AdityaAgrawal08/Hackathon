/**
 * Phase 4 Deterministic LinUCB Contextual Multi-Armed Bandit & EV Decision Engine Tests
 *
 * Verifies:
 * 1. Exact Gauss-Jordan elimination with partial pivoting for dimension-5 design matrices.
 * 2. 5-Arm Enterprise Bandit (SMS_1TAP_UPI, EMAIL_1TAP_UPI, IN_FLIGHT_CASCADE, B2B_EARLY_SETTLEMENT, SPLIT_PAY_3X).
 * 3. Exact mathematical determinism (zero stochastic drift, zero external dependencies).
 * 4. Online reinforcement learning: variance shrinkage, exploration vs exploitation.
 * 5. Multi-rail SMS <-> Email failover via autonomous perception loop.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  LinUCBBandit,
  ENTERPRISE_BANDIT_ACTIONS,
  type EnterpriseBanditAction,
  type EnterpriseContextVector,
  invertMatrixN,
} from "../../packages/core/src/agent/contextual_bandit.js";
import {
  rePlanRecoveryAction,
  type CustomerInteractionEvent,
} from "../../packages/core/src/agent/recovery_agent.js";
import { type StoppingRuleContext } from "../../packages/core/src/agent/stopping_rules.js";

describe("Phase 4: Deterministic LinUCB & EV Decision Engine", () => {
  describe("1. Dimension-5 Linear Algebra & Inversion Exactness", () => {
    it("inverts 5x5 identity matrix exactly to 5x5 identity", () => {
      const I5 = [
        1, 0, 0, 0, 0,
        0, 1, 0, 0, 0,
        0, 0, 1, 0, 0,
        0, 0, 0, 1, 0,
        0, 0, 0, 0, 1,
      ];
      const inv = invertMatrixN(I5, 5);
      expect(inv).toHaveLength(25);
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
          const expected = i === j ? 1 : 0;
          expect(Math.abs(inv[i * 5 + j] - expected)).toBeLessThan(1e-12);
        }
      }
    });

    it("satisfies M * M^-1 = I_5 within 1e-9 for positive-definite design matrix", () => {
      // Create a 5x5 symmetric positive-definite matrix A = I + X^T X
      const x = [0.4, 0.2, 0.8, 0.1, 0.5];
      const A = new Array(25).fill(0);
      for (let i = 0; i < 5; i++) {
        A[i * 5 + i] = 1.0; // Ridge regularization
        for (let j = 0; j < 5; j++) {
          A[i * 5 + j] += x[i] * x[j];
        }
      }

      const invA = invertMatrixN(A, 5);

      // Verify A * invA = I_5
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
          let sum = 0;
          for (let k = 0; k < 5; k++) {
            sum += A[i * 5 + k] * invA[k * 5 + j];
          }
          const expected = i === j ? 1.0 : 0.0;
          expect(Math.abs(sum - expected)).toBeLessThan(1e-9);
        }
      }
    });

    it("executes 5x5 inversion in sub-millisecond time (< 0.1ms per inversion)", () => {
      const A = [
        2.5, 0.3, 0.1, 0.4, 0.2,
        0.3, 3.1, 0.2, 0.1, 0.5,
        0.1, 0.2, 1.8, 0.3, 0.1,
        0.4, 0.1, 0.3, 2.9, 0.4,
        0.2, 0.5, 0.1, 0.4, 3.5,
      ];

      const iterations = 500;
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        invertMatrixN(A, 5);
      }
      const elapsed = performance.now() - start;
      const perInversionMs = elapsed / iterations;

      expect(perInversionMs).toBeLessThan(0.1); // Extremely fast closed-form O(d^3)
    });
  });

  describe("2. Enterprise 5-Arm Contextual Bandit Mechanics", () => {
    let bandit: LinUCBBandit<EnterpriseBanditAction>;

    beforeEach(() => {
      bandit = LinUCBBandit.createEnterpriseBandit(0.2);
    });

    it("initializes all 5 enterprise arms with identity covariance and 0 pulls", () => {
      const state = bandit.getState();
      expect(Object.keys(state)).toHaveLength(5);
      for (const action of ENTERPRISE_BANDIT_ACTIONS) {
        expect(state[action]).toBeDefined();
        expect(state[action].pullCount).toBe(0);
        expect(state[action].totalReward).toBe(0);
        expect(state[action].A).toHaveLength(25);
        expect(state[action].b).toHaveLength(5);
      }
    });

    it("builds valid 5-dimensional normalized enterprise context vector", () => {
      const ctx = LinUCBBandit.buildEnterpriseContext(
        500000, // ₹5,000 (paise) -> 5000 / 10000 = 0.5
        30,     // 30s dwell -> 30 / 60 = 0.5
        60,     // 60m latency -> 60 / 240 = 0.25
        1,      // 1 failure -> 1 / 5 = 0.2
        0.8     // responsiveness -> 0.8
      );

      expect(ctx).toEqual([0.5, 0.5, 0.25, 0.2, 0.8]);
      for (const val of ctx) {
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(1);
      }
    });

    it("selects actions with 100% mathematical determinism across identical runs", () => {
      const context: EnterpriseContextVector = [0.3, 0.4, 0.2, 0.2, 0.7];
      const result1 = bandit.selectArm(context);
      const result2 = bandit.selectArm(context);

      expect(result1.action).toBe(result2.action);
      expect(result1.ucbScore).toBe(result2.ucbScore);
      expect(result1.estimatedReward).toBe(result2.estimatedReward);
      expect(result1.confidenceBound).toBe(result2.confidenceBound);
    });

    it("exploits high-reward action over repeatedly unrewarded actions", () => {
      const context: EnterpriseContextVector = [0.2, 0.5, 0.1, 0.0, 0.9];

      // Reward SMS_1TAP_UPI 15 times with 1.0
      for (let i = 0; i < 15; i++) {
        bandit.updateArm("SMS_1TAP_UPI", context, 1.0);
      }

      // Penalize EMAIL_1TAP_UPI 15 times with 0.0
      for (let i = 0; i < 15; i++) {
        bandit.updateArm("EMAIL_1TAP_UPI", context, 0.0);
      }

      const selection = bandit.selectArm(context);
      expect(selection.action).toBe("SMS_1TAP_UPI");
      expect(selection.estimatedReward).toBeGreaterThan(0.8);
    });

    it("progressively shrinks confidence bound (uncertainty variance) as arm is pulled", () => {
      const context: EnterpriseContextVector = [0.5, 0.5, 0.2, 0.2, 0.5];

      const initialSelection = bandit.selectArm(context);
      const initialVarianceBound = initialSelection.confidenceBound;

      // Pull and update arm 20 times
      for (let i = 0; i < 20; i++) {
        bandit.updateArm(initialSelection.action, context, 0.7);
      }

      const postSelection = bandit.selectArm(context);
      expect(postSelection.confidenceBound).toBeLessThan(initialVarianceBound);
    });
  });

  describe("3. Multi-Rail Cascade & Autonomous Re-Planning", () => {
    const daytimeMs = new Date("2026-09-04T11:00:00Z").getTime();

    it("autonomously triggers cross-channel failover from SMS to Email when SMS unopened after 2h", () => {
      const event: CustomerInteractionEvent = {
        eventId: "evt_sms_unopened",
        interactionType: "SMS_DELIVERED",
        timeSinceFailureMinutes: 130, // 2h 10m
        nowMs: daytimeMs,
      };

      const stoppingCtx: StoppingRuleContext = {
        touchCount: 1,
        lastTouchAtUtc: new Date(daytimeMs - 5 * 3600 * 1000).toISOString(),
        isOptedOut: false,
        createdAtUtc: new Date(daytimeMs - 5 * 3600 * 1000).toISOString(),
        domain: "D2C_CHECKOUT",
        nowMs: daytimeMs,
      };

      const enterpriseBandit = LinUCBBandit.createEnterpriseBandit();
      const rePlan = rePlanRecoveryAction(event, stoppingCtx, enterpriseBandit, {
        enableWhatsApp: false, // Strict Track 3 Email/SMS priority
      });

      expect(rePlan.action).toBe("SWITCH_TO_EMAIL");
      expect(rePlan.reason).toContain("transactional Email");
      expect(rePlan.banditSelection).toBeDefined();
    });

    it("autonomously triggers cross-channel failover from Email to SMS when Email unopened after 2h", () => {
      const event: CustomerInteractionEvent = {
        eventId: "evt_email_unopened",
        interactionType: "EMAIL_DELIVERED",
        timeSinceFailureMinutes: 150, // 2h 30m
        nowMs: daytimeMs,
      };

      const stoppingCtx: StoppingRuleContext = {
        touchCount: 1,
        lastTouchAtUtc: new Date(daytimeMs - 5 * 3600 * 1000).toISOString(),
        isOptedOut: false,
        createdAtUtc: new Date(daytimeMs - 5 * 3600 * 1000).toISOString(),
        domain: "D2C_CHECKOUT",
        nowMs: daytimeMs,
      };

      const enterpriseBandit = LinUCBBandit.createEnterpriseBandit();
      const rePlan = rePlanRecoveryAction(event, stoppingCtx, enterpriseBandit, {
        enableWhatsApp: false,
      });

      expect(rePlan.action).toBe("SWITCH_TO_SMS");
      expect(rePlan.reason).toContain("urgent SMS");
      expect(rePlan.banditSelection).toBeDefined();
    });

    it("promotes 1-Tap UPI Intent on secondary card failure in portal", () => {
      const event: CustomerInteractionEvent = {
        eventId: "evt_card_failed",
        interactionType: "PAYMENT_ATTEMPTED_FAILED",
        timeSinceFailureMinutes: 15,
        cartAmountPaise: 350000,
        nowMs: daytimeMs,
      };

      const stoppingCtx: StoppingRuleContext = {
        touchCount: 1,
        lastTouchAtUtc: new Date(daytimeMs - 5 * 3600 * 1000).toISOString(),
        isOptedOut: false,
        createdAtUtc: new Date(daytimeMs - 5 * 3600 * 1000).toISOString(),
        domain: "D2C_CHECKOUT",
        nowMs: daytimeMs,
      };

      const enterpriseBandit = LinUCBBandit.createEnterpriseBandit();
      const rePlan = rePlanRecoveryAction(event, stoppingCtx, enterpriseBandit);

      expect(rePlan.action).toBe("SWITCH_TO_1TAP_UPI");
      expect(rePlan.reason).toContain("1-Tap Mobile UPI Intent");
      expect(rePlan.banditSelection).toBeDefined();
      expect(rePlan.banditSelection?.action).toBeDefined();
    });
  });
});
