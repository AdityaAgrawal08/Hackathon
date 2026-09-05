/**
 * Tests for ReflectionEngine (Multi-Step Closed-Loop) and UnifiedRecoveryCoordinator (3 Domains)
 */
import { describe, it, expect } from "vitest";
import { ReflectionEngine, defaultReflectionEngine } from "../../packages/core/src/agent/reflection.js";
import { UnifiedRecoveryCoordinator, defaultUnifiedCoordinator } from "../../packages/core/src/agent/unified_coordinator.js";

describe("ReflectionEngine Multi-Step Autonomous Escalation Tests", () => {
  const engine = new ReflectionEngine();

  it("suppresses escalation if customer has opted out", () => {
    const decision = engine.reflect({
      eventId: "evt_1",
      customerProfileId: "cust_1",
      amountPaise: 499900,
      failureClass: "SOFT_RETRYABLE",
      initialChannel: "SMS",
      initialDispatchedAtUtc: new Date(Date.now() - 3600000).toISOString(),
      portalViewed: false,
      portalExitedWithoutPay: false,
      touchCount: 1,
      optedOut: true,
    });

    expect(decision.shouldEscalate).toBe(false);
    expect(decision.adaptationStrategy).toBe("SUPPRESS_FATIGUE");
    expect(decision.reason).toContain("opted out");
  });

  it("triggers downsell discount when customer showed exit intent on portal", () => {
    // 14:00 UTC = 19:30 IST (outside quiet hours)
    const middayMs = new Date("2026-09-05T14:00:00Z").getTime();
    const decision = engine.reflect({
      eventId: "evt_2",
      customerProfileId: "cust_2",
      amountPaise: 500000, // ₹5,000.00
      failureClass: "SOFT_RETRYABLE",
      initialChannel: "SMS",
      initialDispatchedAtUtc: new Date(middayMs - 1800000).toISOString(),
      portalViewed: true,
      portalExitedWithoutPay: true,
      touchCount: 1,
      optedOut: false,
    }, middayMs);

    expect(decision.shouldEscalate).toBe(true);
    expect(decision.adaptationStrategy).toBe("DOWNSELL_DISCOUNT");
    expect(decision.suggestedDiscountBps).toBe(1000); // 10%
    expect(decision.safeAmountPaise).toBe(450000); // ₹4,500.00
  });

  it("autonomously switches channel after observation window expires", () => {
    const middayMs = new Date("2026-09-05T14:00:00Z").getTime();
    const decision = engine.reflect({
      eventId: "evt_3",
      customerProfileId: "cust_3",
      amountPaise: 299900,
      failureClass: "HARD_METHOD_DEAD",
      initialChannel: "SMS",
      initialDispatchedAtUtc: new Date(middayMs - 1800000).toISOString(), // 30 mins ago
      portalViewed: false,
      portalExitedWithoutPay: false,
      touchCount: 1,
      optedOut: false,
    }, middayMs);

    expect(decision.shouldEscalate).toBe(true);
    expect(decision.nextChannel).toBe("EMAIL");
    expect(decision.adaptationStrategy).toBe("CHANNEL_SWITCH");
  });
});

describe("UnifiedRecoveryCoordinator Multi-Domain Tests", () => {
  const coordinator = new UnifiedRecoveryCoordinator();

  it("plans instant 1-Tap UPI for E-Commerce checkout failures", () => {
    const plan = coordinator.planRecovery({
      domain: "ECOMMERCE",
      referenceId: "order_ecom_1",
      customerId: "cust_ecom_1",
      customerName: "Rahul Sharma",
      phone: "919876543210",
      amountPaise: 249900,
      failureCode: "payment_failed",
    });

    expect(plan.domain).toBe("ECOMMERCE");
    expect(plan.executionChannel).toBe("SMS");
    expect(plan.timingStrategy).toBe("IMMEDIATE_0_TO_3_MINS");
    expect(plan.expectedRecoveryRate).toBeGreaterThan(0.5);
  });

  it("plans 06:30 AM pre-debit notice for SaaS recurring subscriptions", () => {
    const plan = coordinator.planRecovery({
      domain: "SUBSCRIPTIONS",
      referenceId: "sub_saas_1",
      customerId: "cust_saas_1",
      customerName: "Acme Corp",
      email: "finance@acme.com",
      amountPaise: 999900,
      subscriptionCycleDay: 5,
    });

    expect(plan.domain).toBe("SUBSCRIPTIONS");
    expect(plan.executionChannel).toBe("EMAIL");
    expect(plan.timingStrategy).toBe("SCHEDULED_NEXT_0630_IST");
    expect(plan.recommendedAction).toBe("SCHEDULE_0630_PRE_DEBIT_NOTICE");
  });

  it("plans 2/10 Net 30 working capital discount for overdue B2B receivables", () => {
    const plan = coordinator.planRecovery({
      domain: "B2B",
      referenceId: "inv_b2b_101",
      customerId: "buyer_b2b_1",
      customerName: "Zenith Enterprises",
      email: "ap@zenith.in",
      amountPaise: 50000000, // ₹5,00,000.00
      dueDateUtc: "2026-09-01T00:00:00Z",
    });

    expect(plan.domain).toBe("B2B");
    expect(plan.executionChannel).toBe("EMAIL");
    expect(plan.recommendedAction).toBe("B2B_2_10_NET_30_DISCOUNT");
    expect(plan.adjustedAmountPaise).toBe(49000000); // 2% discount = ₹4,90,000.00
    expect(plan.workingCapitalBenefitPaise).toBeGreaterThan(0);
  });
});
