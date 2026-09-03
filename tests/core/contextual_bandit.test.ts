/**
 * Automated Tests for Phase 1 / Task 7.1 (BDT-16): Deterministic LinUCB Contextual Multi-Armed Bandit
 */
import { describe, it, expect } from "vitest";
import {
  LinUCBBandit,
  invertMatrix4,
  matVecMul4,
  dotProduct4,
  BANDIT_ACTIONS,
  type ContextVector,
} from "../../packages/core/src/agent/contextual_bandit.js";
import { rePlanRecoveryAction } from "../../packages/core/src/agent/recovery_agent.js";
import type { StoppingRuleContext } from "../../packages/core/src/agent/stopping_rules.js";

describe("Phase 1 / Task 7.1 (BDT-16): Deterministic LinUCB Contextual Bandit", () => {
  describe("1. Linear Algebra Exactness (Dimension 4)", () => {
    it("inverts identity matrix perfectly to identity matrix", () => {
      const I4 = [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ];
      const inv = invertMatrix4(I4);
      expect(inv).toEqual(I4);
    });

    it("satisfies M * M^-1 = I4 identity to within 1e-9 for non-trivial matrix", () => {
      const M = [
        2, 0.5, 0.2, 0.1,
        0.5, 3, 0.4, 0.2,
        0.2, 0.4, 2.5, 0.3,
        0.1, 0.2, 0.3, 1.8,
      ];
      const invM = invertMatrix4(M);

      // Verify each row-column dot product equals Kronecker delta
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          let sum = 0;
          for (let k = 0; k < 4; k++) {
            sum += M[r * 4 + k]! * invM[k * 4 + c]!;
          }
          const expected = r === c ? 1 : 0;
          expect(sum).toBeCloseTo(expected, 8);
        }
      }
    });
  });

  describe("2. Deterministic Arm Selection & Context Building", () => {
    it("builds valid normalized context vector without NaNs or unconstrained values", () => {
      const ctx = LinUCBBandit.buildContext(499900, 2, 45, 0.8);
      expect(ctx[0]).toBeCloseTo(0.4999, 3); // ₹4,999 / ₹10,000
      expect(ctx[1]).toBe(0.4); // 2 / 5
      expect(ctx[2]).toBe(0.75); // 45s / 60s
      expect(ctx[3]).toBe(0.8); // 0.8
      expect(ctx.every((val) => val >= 0 && val <= 1)).toBe(true);
    });

    it("selects action deterministically with exact floating point reproducibility", () => {
      const bandit = new LinUCBBandit(0.2);
      const ctx: ContextVector = [0.5, 0.2, 0.5, 0.7];

      const sel1 = bandit.selectArm(ctx);
      const sel2 = bandit.selectArm(ctx);

      expect(sel1.action).toBe(sel2.action);
      expect(sel1.ucbScore).toBe(sel2.ucbScore);
      expect(sel1.confidenceBound).toBe(sel2.confidenceBound);
      expect(sel1.estimatedReward).toBe(sel2.estimatedReward);
    });
  });

  describe("3. Online Policy Learning & Exploration-Exploitation Tradeoff", () => {
    it("learns to exploit high-reward action over repeatedly unrewarded alternatives", () => {
      const bandit = new LinUCBBandit(0.2);
      const highTicketCtx: ContextVector = [0.85, 0.4, 0.6, 0.5]; // High ticket ₹8,500

      // Train bandit: Split-Pay yields high net margin reward (0.90), UPI intent drops (0.10)
      for (let t = 0; t < 15; t++) {
        bandit.updateArm("TRIGGER_SPLIT_PAY_3X", highTicketCtx, 0.92);
        bandit.updateArm("SWITCH_TO_1TAP_UPI", highTicketCtx, 0.15);
      }

      const decision = bandit.selectArm(highTicketCtx);
      expect(decision.action).toBe("TRIGGER_SPLIT_PAY_3X");
      expect(decision.estimatedReward).toBeGreaterThan(0.7);

      // Verify that pull counts and total rewards are tracked
      const state = bandit.getState();
      expect(state.TRIGGER_SPLIT_PAY_3X.pullCount).toBe(15);
      expect(state.TRIGGER_SPLIT_PAY_3X.totalReward).toBeCloseTo(15 * 0.92, 1);
    });

    it("shrinks uncertainty bound (variance) as an arm is repeatedly pulled", () => {
      const bandit = new LinUCBBandit(0.2);
      const ctx: ContextVector = [0.5, 0.2, 0.5, 0.5];

      const initialSel = bandit.selectArm(ctx);
      const initialConfidence = initialSel.confidenceBound;

      // Pull the selected arm 20 times
      for (let i = 0; i < 20; i++) {
        bandit.updateArm(initialSel.action, ctx, 0.7);
      }

      const subsequentSel = bandit.selectArm(ctx);
      // The uncertainty for this arm should have shrunk because A_a eigenvalues grew
      expect(subsequentSel.confidenceBound).toBeLessThan(initialConfidence);
    });
  });

  describe("4. Integration with Autonomous Perception Loop & Hard Guards", () => {
    it("embeds LinUCB selection into rePlanRecoveryAction without violating stopping rules", () => {
      const daytimeMs = Date.UTC(2026, 8, 3, 6, 0, 0); // 11:30 AM IST (active window)
      const stoppingCtx: StoppingRuleContext = {
        touchCount: 1,
        lastTouchAtUtc: new Date(daytimeMs - 5 * 3600 * 1000).toISOString(),
        isOptedOut: false,
        createdAtUtc: new Date(daytimeMs - 6 * 3600 * 1000).toISOString(),
        domain: "D2C_CHECKOUT",
        nowMs: daytimeMs,
      };

      const event = {
        eventId: "evt_bandit_test",
        interactionType: "PORTAL_EXITED_NO_PAY" as const,
        timeSinceFailureMinutes: 15,
        dwellTimeSeconds: 30,
        cartAmountPaise: 499900,
        nowMs: daytimeMs,
      };

      const result = rePlanRecoveryAction(event, stoppingCtx);

      expect(result.action).toBe("TRIGGER_DOWNSELL_SPLIT");
      expect(result.banditSelection).toBeDefined();
      expect(result.banditSelection?.ucbScore).toBeGreaterThan(0);
      expect(result.reason).toContain("LinUCB score");
    });

    it("strictly honors opt-out kill switch regardless of bandit scores", () => {
      const stoppingCtx: StoppingRuleContext = {
        touchCount: 1,
        lastTouchAtUtc: new Date().toISOString(),
        isOptedOut: true, // Customer opted out
        createdAtUtc: new Date().toISOString(),
        domain: "D2C_CHECKOUT",
      };

      const event = {
        eventId: "evt_bandit_opt_out",
        interactionType: "CUSTOMER_OPT_OUT" as const,
        timeSinceFailureMinutes: 5,
      };

      const result = rePlanRecoveryAction(event, stoppingCtx);
      expect(result.action).toBe("TERMINATE_STOP_RULE");
      expect(result.reason).toContain("opt-out");
    });
  });
});
