/**
 * Automated Tests for Merchant Unit Economics & P&L Engine (Task 6.4 / FIN-13)
 */
import { describe, it, expect } from "vitest";
import {
  computeMdrSavingsPaise,
  computeIncrementalLift,
  computeNetMarginPreservedPaise,
  computeUnitCostPer100Won,
  CHANNEL_COGS_PAISE,
  MDR_RATES_BPS,
} from "../../packages/shared/src/economics.js";

describe("Task 6.4 / FIN-13: CFO Merchant Unit Economics Engine", () => {
  describe("1. Payment Rail MDR Fee Arbitrage", () => {
    it("computes 200 bps (2.0%) savings when converting failed Credit Card to 1-Tap UPI", () => {
      const amountPaise = 1000000; // ₹10,000
      const savings = computeMdrSavingsPaise(amountPaise, "card", "upi");
      // 2% of ₹10,000 = ₹200 (20,000 paise)
      expect(savings).toBe(20000);
    });

    it("computes 150 bps (1.5%) savings when converting Netbanking to 1-Tap UPI", () => {
      const amountPaise = 1000000; // ₹10,000
      const savings = computeMdrSavingsPaise(amountPaise, "netbanking", "upi");
      // 1.5% of ₹10,000 = ₹150 (15,000 paise)
      expect(savings).toBe(15000);
    });

    it("returns 0 savings if original payment was already zero-fee UPI", () => {
      const amountPaise = 1000000;
      const savings = computeMdrSavingsPaise(amountPaise, "upi", "upi");
      expect(savings).toBe(0);
    });
  });

  describe("2. Counterfactual Attribution (True Incremental Lift)", () => {
    it("subtracts 18.2% natural return baseline from gross recovery", () => {
      const totalAtRiskPaise = 10000000; // ₹1,00,000
      const grossRecoveredPaise = 6000000; // ₹60,000 (60% gross)

      const lift = computeIncrementalLift(grossRecoveredPaise, totalAtRiskPaise, 0.182);

      // Baseline = ₹18,200 (1,820,000 paise)
      expect(lift.organicBaselinePaise).toBe(1820000);
      // True Lift = ₹60,000 - ₹18,200 = ₹41,800 (4,180,000 paise)
      expect(lift.trueLiftPaise).toBe(4180000);
      expect(lift.liftPercentage).toBe(41.8);
    });
  });

  describe("3. Net Margin Preserved Calculation", () => {
    it("calculates Net Margin subtracting COGS, concessions and adding MDR savings", () => {
      const grossPaise = 5000000; // ₹50,000
      const cogsPaise = 25000;   // ₹250 (Channel costs)
      const discountPaise = 100000; // ₹1,000 (Discounts granted)
      const mdrSavingsPaise = 80000; // ₹800 (Card -> UPI conversion)

      const netMargin = computeNetMarginPreservedPaise(grossPaise, cogsPaise, discountPaise, mdrSavingsPaise);

      // 50,000 - 250 - 1,000 + 800 = 49,550 INR -> 4,955,000 paise
      expect(netMargin).toBe(4955000);
    });
  });

  describe("4. Unit Cost per ₹100 Won", () => {
    it("calculates unit cost of recovery per ₹100 won accurately", () => {
      const totalCostPaise = 4800; // ₹48
      const grossWonPaise = 1000000; // ₹10,000

      const unitCost = computeUnitCostPer100Won(totalCostPaise, grossWonPaise);
      // (48 / 10,000) * 100 = 0.48 INR per ₹100 won
      expect(unitCost).toBe(0.48);
    });
  });
});
