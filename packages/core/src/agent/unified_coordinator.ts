/**
 * Unified 3-Domain Revenue Recovery Coordinator (Track 3)
 *
 * Coordinates autonomous recovery workflows across:
 * 1. E-Commerce / D2C Checkout Abandonment & Payment Failures
 * 2. SaaS Subscriptions & Recurring Mandates (UPI Autopay / eNACH pre-debit notices @ 06:30 AM IST)
 * 3. B2B Invoicing & Overdue Receivables (Dynamic 2/10 Net 30 discounts)
 */

import { isoUtc, paise, formatINR } from "@arbiter/shared";
import { defaultMarginGuard } from "./margin_guard.js";
import { defaultEnterpriseBandit } from "./contextual_bandit.js";

export type RecoveryDomain = "ECOMMERCE" | "SUBSCRIPTIONS" | "B2B";

export interface UnifiedRecoveryRequest {
  domain: RecoveryDomain;
  referenceId: string;
  customerId: string;
  customerName: string;
  email?: string;
  phone?: string;
  amountPaise: number;
  failureCode?: string;
  failureDescription?: string;
  dueDateUtc?: string; // For B2B
  subscriptionCycleDay?: number; // For Subscriptions
  nowMs?: number;
}

export interface UnifiedRecoveryPlan {
  domain: RecoveryDomain;
  referenceId: string;
  recommendedAction: string;
  executionChannel: "SMS" | "EMAIL" | "PAYMENT_LINK" | "PRE_DEBIT_SCHEDULE";
  timingStrategy: string;
  adjustedAmountPaise: number;
  expectedRecoveryRate: number;
  projectedNetMarginPaise: number;
  workingCapitalBenefitPaise?: number;
  auditReasons: string[];
}

export class UnifiedRecoveryCoordinator {
  /**
   * Plans and coordinates the recovery workflow based on the business domain.
   */
  planRecovery(req: UnifiedRecoveryRequest): UnifiedRecoveryPlan {
    const nowMs = req.nowMs ?? Date.now();
    const reasons: string[] = [];

    if (req.domain === "ECOMMERCE") {
      // Domain 1: Instant Checkout Failure Recovery
      reasons.push("High-velocity e-commerce failure detected: prioritizing instant 1-Tap UPI Intent.");
      const banditArm = defaultEnterpriseBandit.selectArm([
        Math.min(1, req.amountPaise / 1000000),
        0,
        0.1,
        0,
        0.75,
      ]);

      return {
        domain: "ECOMMERCE",
        referenceId: req.referenceId,
        recommendedAction: banditArm.action,
        executionChannel: req.phone ? "SMS" : "EMAIL",
        timingStrategy: "IMMEDIATE_0_TO_3_MINS",
        adjustedAmountPaise: req.amountPaise,
        expectedRecoveryRate: Number((banditArm.estimatedReward || 0.65).toFixed(2)),
        projectedNetMarginPaise: req.amountPaise,
        auditReasons: reasons,
      };
    }

    if (req.domain === "SUBSCRIPTIONS") {
      // Domain 2: SaaS Subscriptions & Recurring Mandates (RBI Mandate & UPI Autopay)
      reasons.push("Recurring subscription mandate scheduled: aligning with RBI pre-debit 24h notification rule.");
      reasons.push("Optimal debit timing window calculated at 06:30 AM IST (highest bank liquidity post-clearing).");

      return {
        domain: "SUBSCRIPTIONS",
        referenceId: req.referenceId,
        recommendedAction: "SCHEDULE_0630_PRE_DEBIT_NOTICE",
        executionChannel: req.email ? "EMAIL" : "SMS",
        timingStrategy: "SCHEDULED_NEXT_0630_IST",
        adjustedAmountPaise: req.amountPaise,
        expectedRecoveryRate: 0.82,
        projectedNetMarginPaise: req.amountPaise,
        auditReasons: reasons,
      };
    }

    // Domain 3: B2B Invoicing & Overdue Receivables
    reasons.push("Overdue B2B receivable identified: applying dynamic 2/10 Net 30 working capital discount.");
    const discountBps = 200; // 2% early payment discount
    const safeAmount = defaultMarginGuard.computeSafeDownsellPaise(req.amountPaise, discountBps);
    const wcSavedPaise = Math.round((req.amountPaise * 0.14 * 20) / 365); // 20 days acceleration @ 14% p.a.
    reasons.push(`Accelerating working capital cash flow saves ₹${(wcSavedPaise / 100).toFixed(2)} in interest.`);

    return {
      domain: "B2B",
      referenceId: req.referenceId,
      recommendedAction: "B2B_2_10_NET_30_DISCOUNT",
      executionChannel: "EMAIL",
      timingStrategy: "BUSINESS_HOURS_1000_IST",
      adjustedAmountPaise: safeAmount,
      expectedRecoveryRate: 0.74,
      projectedNetMarginPaise: safeAmount,
      workingCapitalBenefitPaise: wcSavedPaise,
      auditReasons: reasons,
    };
  }
}

export const defaultUnifiedCoordinator = new UnifiedRecoveryCoordinator();
