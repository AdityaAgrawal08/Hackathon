/**
 * Comprehensive Unit Test Suite for Task 3.1: Merchant Domain Context Engine
 * Validates D2C, SaaS, B2B, and High-Ticket EdTech strategies with zero hardcoded fixed values.
 */

import { describe, it, expect } from "vitest";
import {
  buildD2CRecoveryStrategy,
  buildSaaSGracePeriodStrategy,
  buildB2BEarlySettlementStrategy,
  buildHighTicketSplitPayStrategy,
} from "../../packages/core/src/domain/merchant_context.js";

describe("Phase 3: Merchant Domain Context Engine", () => {
  // ── D2C Impulse E-Commerce ──────────────────────────────────────────
  describe("1. D2C Impulse E-Commerce Strategy", () => {
    it("generates compliant 1-Tap UPI Intent URI with dynamic parameters", () => {
      const nowMs = new Date("2026-09-04T10:00:00.000Z").getTime();
      const strategy = buildD2CRecoveryStrategy({
        merchantVpa: "urbanstore@razorpay",
        merchantName: "Urban Store India",
        transactionRef: "ord_d2c_9876",
        amountPaise: 249900, // ₹2,499.00
        cartReservationMins: 20, // Dynamic 20 mins
        concessionDiscountBp: 500, // 5% discount (₹124.95 -> ₹125.00)
        productName: "Wireless Earbuds Pro",
        nowMs,
      });

      expect(strategy.domain).toBe("D2C_ECOMMERCE");
      expect(strategy.originalAmountPaise).toBe(249900);
      expect(strategy.discountPaise).toBe(12495); // 5% of 249900
      expect(strategy.netPayablePaise).toBe(237405);
      expect(strategy.formattedOriginal).toBe("₹2,499.00");
      expect(strategy.formattedNetPayable).toBe("₹2,374.05");

      // Verify UPI Intent URI format
      expect(strategy.upiIntentUri).toContain("upi://pay");
      expect(strategy.upiIntentUri).toContain("pa=urbanstore%40razorpay");
      expect(strategy.upiIntentUri).toContain("pn=Urban+Store+India");
      expect(strategy.upiIntentUri).toContain("am=2374.05");
      expect(strategy.upiIntentUri).toContain("tr=ord_d2c_9876");

      // Verify cart hold expiration
      expect(strategy.cartReservationMins).toBe(20);
      const expiryMs = new Date(strategy.cartExpiresAtUtc).getTime();
      expect(expiryMs - nowMs).toBe(20 * 60 * 1000);
      expect(strategy.badgeText).toContain("Cart reserved for 20 mins");
      expect(strategy.customerCtaText).toContain("5% discount applied");
    });

    it("handles zero-discount concession gracefully", () => {
      const strategy = buildD2CRecoveryStrategy({
        merchantVpa: "store@razorpay",
        merchantName: "Store",
        transactionRef: "tx_1",
        amountPaise: 100000,
        concessionDiscountBp: 0,
      });

      expect(strategy.discountPaise).toBe(0);
      expect(strategy.netPayablePaise).toBe(100000);
      expect(strategy.customerCtaText).not.toContain("discount applied");
      expect(strategy.customerCtaText).toContain("via 1-Tap UPI");
    });
  });

  // ── SaaS Recurring Mandates ─────────────────────────────────────────
  describe("2. SaaS Recurring Mandates Strategy", () => {
    it("generates RBI compliant 24h pre-debit notice when retries remain", () => {
      const nowMs = new Date("2026-09-04T08:00:00.000Z").getTime();
      const strategy = buildSaaSGracePeriodStrategy({
        mandateId: "man_saas_442",
        planName: "Enterprise Cloud Suite",
        amountPaise: 499900, // ₹4,999.00
        retryCount: 1,
        maxRetries: 3,
        softLockGraceDays: 5,
        rbiAdvanceNoticeHours: 24,
        nowMs,
      });

      expect(strategy.domain).toBe("SAAS_MANDATES");
      expect(strategy.isSoftLocked).toBe(false);
      expect(strategy.rbiCompliant).toBe(true);
      expect(strategy.strategyAction).toBe("PRE_DEBIT_NOTIFICATION");
      expect(strategy.hoursUntilDebit).toBe(24);

      const noticeMs = new Date(strategy.preDebitNoticeAtUtc).getTime();
      const debitMs = new Date(strategy.scheduledDebitAtUtc).getTime();
      expect(debitMs - noticeMs).toBe(24 * 3600 * 1000);
      expect(strategy.customerMessage).toContain("RBI Advance Notice");
      expect(strategy.customerMessage).toContain("Enterprise Cloud Suite");
    });

    it("triggers soft-lock grace notice when max retries are exhausted", () => {
      const nowMs = new Date("2026-09-04T08:00:00.000Z").getTime();
      const strategy = buildSaaSGracePeriodStrategy({
        mandateId: "man_saas_999",
        planName: "Basic Plan",
        amountPaise: 99900,
        retryCount: 3,
        maxRetries: 3,
        softLockGraceDays: 7, // Dynamic 7 days grace
        nowMs,
      });

      expect(strategy.isSoftLocked).toBe(true);
      expect(strategy.strategyAction).toBe("SOFT_LOCK_GRACE_NOTICE");
      expect(strategy.hoursUntilDebit).toBe(0);

      const expiresMs = new Date(strategy.softLockExpiresAtUtc).getTime();
      expect(expiresMs - nowMs).toBe(7 * 86400 * 1000);
      expect(strategy.customerMessage).toContain("7-day grace period");
      expect(strategy.customerMessage).toContain("switch bank account");
    });
  });

  // ── B2B Corporate Invoices ──────────────────────────────────────────
  describe("3. B2B Corporate Invoices (2/10 Net 30)", () => {
    it("computes dynamic 2/10 Net 30 economics and working capital savings", () => {
      const nowMs = new Date("2026-09-04T12:00:00.000Z").getTime();
      const strategy = buildB2BEarlySettlementStrategy({
        invoiceId: "inv_corp_1001",
        invoiceNumber: "INV-2026-8801",
        clientCompany: "Acme Logistics Ltd",
        contactPerson: "Rajesh Varma",
        contactEmail: "finance@acme.example",
        amountPaise: 50000000, // ₹5,00,000.00
        dueDateUtc: new Date(nowMs + 30 * 86400000).toISOString(),
        discountPercent: 2.0, // 2%
        annualCostOfCapital: 0.14, // 14% p.a.
        dsoDaysSaved: 20, // 20 days early
        nowMs,
      });

      expect(strategy.domain).toBe("B2B_INVOICES");
      expect(strategy.originalAmountPaise).toBe(50000000);
      expect(strategy.discountPercent).toBe(2.0);
      expect(strategy.discountPaise).toBe(1000000); // 2% of 5L = ₹10,000
      expect(strategy.discountedAmountPaise).toBe(49000000); // ₹4,90,000

      // Working Capital Savings = 50000000 * 0.14 * 20 / 365 = 383561.64 -> 383562 paise (₹3,835.62)
      expect(strategy.workingCapitalSavedPaise).toBe(383562);

      // Smart Collect VPA format
      expect(strategy.smartCollectVpa).toContain("smartcollect.b2b.inv20268801@razorpay");
      expect(strategy.formalEmailBody).toContain("INV-2026-8801");
      expect(strategy.formalEmailBody).toContain("₹4,90,000.00");
      expect(strategy.formalEmailBody).toContain("Dedicated UPI VPA");
    });
  });

  // ── High-Ticket EdTech (3x Split-Pay) ────────────────────────────────
  describe("4. High-Ticket EdTech (3x Split-Pay Schedule)", () => {
    it("preserves integer paise invariant I-5 across all installments", () => {
      const nowMs = new Date("2026-09-04T12:00:00.000Z").getTime();
      const totalAmountPaise = 3499900; // ₹34,999.00 (not evenly divisible by 3)

      const strategy = buildHighTicketSplitPayStrategy({
        totalAmountPaise,
        customerName: "Sneha Patel",
        productName: "Full Stack AI Fellowship",
        installmentCount: 3,
        nowMs,
      });

      expect(strategy.domain).toBe("HIGH_TICKET");
      expect(strategy.totalAmountPaise).toBe(totalAmountPaise);
      expect(strategy.installmentCount).toBe(3);
      expect(strategy.installments.length).toBe(3);

      // Invariant check: sum strictly equals total
      expect(strategy.isSumPreserved).toBe(true);
      expect(strategy.sumInstallmentsPaise).toBe(totalAmountPaise);
      expect(strategy.interestMarkupBp).toBe(0);

      // Remainder allocation: 3499900 / 3 = 1166633 r 1 -> 1st installment gets +1 paise
      expect(strategy.installments[0].amountPaise).toBe(1166634);
      expect(strategy.installments[1].amountPaise).toBe(1166633);
      expect(strategy.installments[2].amountPaise).toBe(1166633);

      expect(strategy.installments[0].status).toBe("DUE_NOW");
      expect(strategy.installments[1].status).toBe("SCHEDULED");
      expect(strategy.installments[2].status).toBe("SCHEDULED");

      // Verify date schedule: Day 0, Day 30, Day 60
      expect(strategy.installments[0].dueDayOffset).toBe(0);
      expect(strategy.installments[1].dueDayOffset).toBe(30);
      expect(strategy.installments[2].dueDayOffset).toBe(60);
    });
  });
});
