import { describe, it, expect, beforeEach } from "vitest";
import {
  TLearnerUpliftModel,
  defaultTLearnerUpliftModel,
} from "../../packages/core/src/agent/uplift_model.js";
import {
  recordBankDowntime,
  getBankHealth,
  clearBankDowntimes,
} from "../../packages/core/src/ingest/rail_health.js";
import {
  evaluatePreFlightSteering,
  steerCustomerVpa,
  extractBankFromVpa,
} from "../../packages/core/src/agent/rail_steering.js";
import {
  scheduleMandateRetry,
  type SubscriptionMandate,
} from "../../packages/core/src/domain/index.js";

describe("TASK-007, TASK-008, TASK-009, TASK-016: Platform Interplay & Causal Uplift", () => {
  beforeEach(() => {
    clearBankDowntimes();
  });

  describe("TASK-009 & TASK-016: Causal Uplift Modeling (T-Learner) for MarginGuard", () => {
    const upliftModel = new TLearnerUpliftModel();

    it("refuses discounts for high-affinity 'Sure Thing' customers to eliminate margin cannibalization", () => {
      const loyalCustomer = {
        amountPaise: 499900,
        priorSuccessCount: 4,
        priorFailureCount: 0,
        customerTier: "HIGH_VALUE" as const,
        failureCategory: "TECHNICAL" as const,
        hoursSinceFailure: 1,
      };

      const decision = upliftModel.evaluateDiscountUplift(loyalCustomer, 10);

      expect(decision.baselineProbability).toBeGreaterThanOrEqual(0.70);
      expect(decision.segment).toBe("SURE_THING");
      expect(decision.authorized).toBe(false);
      expect(decision.reason).toContain("High organic conversion");
    });

    it("approves discounts for price-sensitive 'Persuadable' customers where incremental lift is positive", () => {
      const priceSensitiveCustomer = {
        amountPaise: 299900,
        priorSuccessCount: 0,
        priorFailureCount: 2,
        customerTier: "PRICE_SENSITIVE" as const,
        failureCategory: "LIQUIDITY" as const,
        hoursSinceFailure: 25,
      };

      const decision = upliftModel.evaluateDiscountUplift(priceSensitiveCustomer, 10);

      expect(decision.baselineProbability).toBeLessThan(0.50);
      expect(decision.individualTreatmentEffect).toBeGreaterThanOrEqual(0.10);
      expect(decision.segment).toBe("PERSUADABLE");
      expect(decision.authorized).toBe(true);
      expect(decision.incrementalLiftPaise).toBeGreaterThan(0);
      expect(decision.reason).toContain("Approved: Persuadable customer profile");
    });

    it("refuses discounts for 'Lost Cause' customer profiles who do not respond to pricing incentives", () => {
      const lostCause = {
        amountPaise: 1500000,
        priorSuccessCount: 0,
        priorFailureCount: 5,
        customerTier: "STANDARD" as const,
        failureCategory: "LIQUIDITY" as const,
        hoursSinceFailure: 72,
      };

      const decision = upliftModel.evaluateDiscountUplift(lostCause, 10);

      expect(decision.authorized).toBe(false);
      expect(["LOST_CAUSE", "SURE_THING", "SLEEPING_DOG", "PERSUADABLE"]).toContain(decision.segment);
    });
  });

  describe("TASK-007: Bank Downtime Interception & UPI Switch Steering", () => {
    it("extracts bank issuer accurately from Indian UPI VPA handles", () => {
      expect(extractBankFromVpa("rahul@okhdfcbank")).toBe("HDFC");
      expect(extractBankFromVpa("priya@okaxis")).toBe("AXIS");
      expect(extractBankFromVpa("anand@okicici")).toBe("ICICI");
      expect(extractBankFromVpa("user@ybl")).toBe("YESBANK");
      expect(extractBankFromVpa("invalid")).toBeNull();
    });

    it("steers customer VPA to healthy alternate bank handle", () => {
      expect(steerCustomerVpa("rahul@okhdfcbank", "AXIS")).toBe("rahul@okaxis");
      expect(steerCustomerVpa("rahul@okhdfcbank", "ICICI")).toBe("rahul@okicici");
    });

    it("intercepts degraded bank switch pre-flight and steers to healthy switch", () => {
      // Normal state: HDFC is UP
      const healthyCheck = evaluatePreFlightSteering({
        customerVpa: "customer@okhdfcbank",
        amountPaise: 199900,
      });
      expect(healthyCheck.steered).toBe(false);

      // Ingest downtime event: HDFC switch goes DOWN
      recordBankDowntime("HDFC", "DOWN", "HIGH", "upi");
      const hdfcHealth = getBankHealth("HDFC");
      expect(hdfcHealth.degraded).toBe(true);

      // Pre-flight check during downtime: must intercept and steer!
      const intercepted = evaluatePreFlightSteering({
        customerVpa: "customer@okhdfcbank",
        amountPaise: 199900,
      });

      expect(intercepted.steered).toBe(true);
      expect(intercepted.originalRail).toBe("HDFC");
      expect(intercepted.recommendedRail).toBe("AXIS");
      expect(intercepted.suggestedVpa).toBe("customer@okaxis");
      expect(intercepted.userMessage).toContain("servers are experiencing high downtime");
    });
  });

  describe("TASK-008: Subscription Mandate (UPI Autopay) Sequencer", () => {
    it("generates RBI-compliant 24h pre-debit notice scheduled for 06:30 AM IST liquidity window", () => {
      const mandate: SubscriptionMandate = {
        id: "sub_mandate_01",
        customerId: "cust_saas_01",
        customerName: "SaaS Enterprise",
        customerPhone: "+919876500001",
        mandateType: "UPI_AUTOPAY",
        planName: "Pro Tier Monthly",
        amountPaise: 999900,
        retrySequenceCount: 0,
        maxRetries: 3,
        status: "ACTIVE",
        createdAtUtc: new Date().toISOString(),
      };

      const nowMs = 1772670000000;
      const plan = scheduleMandateRetry(mandate, "INSUFFICIENT_FUNDS", nowMs);

      expect(plan.rbiCompliant).toBe(true);
      expect(plan.strategy).toBe("SALARY_WINDOW_0630");
      expect(plan.hoursUntilDebit).toBeGreaterThanOrEqual(24);

      // Verify scheduled time is exactly 06:30 AM IST (which is 01:00 AM UTC)
      const scheduledDate = new Date(plan.scheduledDebitAtUtc);
      const istDate = new Date(scheduledDate.getTime() + 5.5 * 3600 * 1000);
      expect(istDate.getUTCHours()).toBe(6);
      expect(istDate.getUTCMinutes()).toBe(30);

      expect(plan.customerMessage).toContain("RBI Mandate Notice");
      expect(plan.customerMessage).toContain("06:30 AM");
    });

    it("transitions to SOFT_LOCK_PROMPT when maximum retries are exhausted", () => {
      const exhaustedMandate: SubscriptionMandate = {
        id: "sub_mandate_02",
        customerId: "cust_saas_02",
        customerName: "SaaS Startup",
        customerPhone: "+919876500002",
        mandateType: "UPI_AUTOPAY",
        planName: "Starter Tier Monthly",
        amountPaise: 299900,
        retrySequenceCount: 3,
        maxRetries: 3,
        status: "ACTIVE",
        createdAtUtc: new Date().toISOString(),
      };

      const plan = scheduleMandateRetry(exhaustedMandate, "INSUFFICIENT_FUNDS");
      expect(plan.strategy).toBe("SOFT_LOCK_PROMPT");
      expect(plan.customerMessage).toContain("grace period");
    });
  });
});
