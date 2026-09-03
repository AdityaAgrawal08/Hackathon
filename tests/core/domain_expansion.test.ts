/**
 * Automated Tests for Track 3 Multi-Domain Scope Expansion (Task 6.1)
 * Covers:
 * 1. SaaS Subscription Mandates (RBI 24-hour advance pre-debit rule + 06:30 AM IST retry)
 * 2. Magic Checkout Abandoned Cart Restoration (Token preservation + 15m price hold)
 * 3. B2B Corporate Receivables (2/10 Net 30 Early Settlement Concession + DSO savings)
 */
import { describe, it, expect } from "vitest";
import {
  scheduleMandateRetry,
  generateCartRecoveryLink,
  calculateEarlySettlementDiscount,
  type SubscriptionMandate,
  type AbandonedCheckout,
  type B2BInvoice,
} from "../../packages/core/src/domain/index.js";

describe("Task 6.1: Multi-Domain Scope Expansion", () => {
  describe("1. SaaS Recurring Subscription Mandates (UPI Autopay / eNACH)", () => {
    it("enforces strict RBI 24-hour advance pre-debit notice invariant and targets 06:30 AM IST", () => {
      const nowMs = Date.UTC(2026, 8, 3, 10, 0, 0); // 10:00 UTC
      const mandate: SubscriptionMandate = {
        id: "man_test_1",
        customerId: "cust_saas_1",
        customerName: "Aarav Mehta",
        customerPhone: "9876543210",
        mandateType: "UPI_AUTOPAY",
        planName: "Pro Enterprise SaaS",
        amountPaise: 499900,
        retrySequenceCount: 0,
        maxRetries: 3,
        status: "ACTIVE",
        createdAtUtc: new Date(nowMs).toISOString(),
      };

      const plan = scheduleMandateRetry(mandate, "BAD_REQUEST_PAYMENT_UPI_AUTOPAY_DECLINED", nowMs);

      expect(plan.rbiCompliant).toBe(true);
      expect(plan.mandateId).toBe("man_test_1");
      expect(plan.strategy).toBe("SALARY_WINDOW_0630");

      const noticeTimeMs = new Date(plan.preDebitNotificationAtUtc).getTime();
      const scheduledDebitTimeMs = new Date(plan.scheduledDebitAtUtc).getTime();
      const diffHours = (scheduledDebitTimeMs - noticeTimeMs) / (3600 * 1000);

      // Must be at least 24 hours per RBI circular
      expect(diffHours).toBeGreaterThanOrEqual(24);

      // Must target 06:30 AM IST (which is 01:00 AM UTC)
      const scheduledDebitDate = new Date(scheduledDebitTimeMs);
      const istHours = (scheduledDebitDate.getUTCHours() + 5.5) % 24;
      const istMinutes = scheduledDebitDate.getUTCMinutes() + (5.5 % 1 !== 0 ? 30 : 0);
      expect(istHours).toBeCloseTo(6.5, 0.1);
      expect(plan.customerMessage).toContain("RBI Mandate Notice");
      expect(plan.customerMessage).toContain("₹4,999.00");
    });

    it("transitions mandate to SOFT_LOCK when max retry sequence count is exhausted", () => {
      const nowMs = Date.now();
      const exhaustedMandate: SubscriptionMandate = {
        id: "man_exhausted_1",
        customerId: "cust_saas_2",
        customerName: "Priya Sharma",
        customerPhone: "9876543211",
        mandateType: "E_NACH",
        planName: "Basic Tier SaaS",
        amountPaise: 99900,
        retrySequenceCount: 3, // Exhausted
        maxRetries: 3,
        status: "SOFT_LOCK",
        createdAtUtc: new Date(nowMs).toISOString(),
      };

      const plan = scheduleMandateRetry(exhaustedMandate, "BANK_ACCOUNT_FROZEN", nowMs);

      expect(plan.strategy).toBe("SOFT_LOCK_PROMPT");
      expect(plan.customerMessage).toContain("entered a grace period");
    });
  });

  describe("2. Abandoned Pre-Payment Checkouts", () => {
    it("generates 1-click cart restoration link with preserved state and 15m price hold", () => {
      const checkout: AbandonedCheckout = {
        id: "chk_cart_101",
        customerName: "Rohan Varma",
        customerPhone: "9123456789",
        cartItemsJson: JSON.stringify([{ id: "item_1", name: "Wireless Headphones", pricePaise: 299900 }]),
        cartAmountPaise: 299900,
        dropOffStep: "PAYMENT_SCREEN_EXITED",
        recoveryToken: "tok_cart_secret_xyz",
        status: "ABANDONED",
        createdAtUtc: new Date().toISOString(),
      };

      const link = generateCartRecoveryLink(checkout, "https://store.acme.com");

      expect(link.checkoutId).toBe("chk_cart_101");
      expect(link.recoveryUrl).toBe("https://store.acme.com/checkout/restore/tok_cart_secret_xyz");
      expect(link.expiresInMinutes).toBe(15);
      expect(link.formattedAmount).toBe("₹2,999.00");
      expect(link.customerMessage).toContain("reserved your cart (₹2,999.00)");
      expect(link.customerMessage).toContain("https://store.acme.com/checkout/restore/tok_cart_secret_xyz");
    });
  });

  describe("3. B2B Corporate Invoices & Receivables (2/10 Net 30 Terms)", () => {
    it("computes dynamic 2/10 Net 30 early settlement terms and working capital cost savings", () => {
      const invoice: B2BInvoice = {
        id: "inv_corp_501",
        vendorId: "techflow",
        clientCompany: "OmniCorp Logistics Ltd",
        contactPerson: "Vikram Singhania",
        contactEmail: "vikram@omnicorp.com",
        amountPaise: 20000000, // ₹2,00,000
        invoiceNumber: "INV-2026-0891",
        dueDateUtc: "2026-09-01T00:00:00.000Z",
        daysOverdue: 14,
        earlyDiscountPercent: 2.0, // 2% discount
        virtualVpa: "smartcollect.techflow@razorpay",
        status: "OVERDUE",
        createdAtUtc: "2026-08-01T00:00:00.000Z",
      };

      const plan = calculateEarlySettlementDiscount(invoice);

      expect(plan.originalAmountPaise).toBe(20000000);
      expect(plan.discountSavedPaise).toBe(400000); // 2% of ₹2,00,000 = ₹4,000
      expect(plan.discountedAmountPaise).toBe(19600000); // ₹1,96,000
      expect(plan.virtualVpa).toBe("smartcollect.techflow@razorpay");
      expect(plan.noticeUrgency).toBe("EARLY_SETTLEMENT_OFFER");

      // Working capital interest saved at 14% across 20 days:
      // (200,000 * 0.14 * 20) / 365 = ~1534.24 INR -> 153425 paise
      expect(plan.workingCapitalSavedPaise).toBeGreaterThan(150000);
      expect(plan.formalSubject).toContain("INV-2026-0891");
      expect(plan.formalNoticeBody).toContain("₹1,96,000.00");
      expect(plan.formalNoticeBody).toContain("smartcollect.techflow@razorpay");
    });
  });

  describe("4. End-to-End API Ingestion Integration", () => {
    it("ingests and queries SaaS mandates, abandoned checkouts, and B2B invoices via server API", async () => {
      const { app, dbClient } = await import("../../app/server.js");
      const { runMigrations } = await import("../../packages/core/src/db/migrate.js");
      await runMigrations(dbClient);

      const server = app.listen(0);
      const addr = server.address() as any;
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      try {
        // 1. Ingest Mandate Auto-Debit Failure
        const mandateRes = await fetch(`${baseUrl}/api/mandates/auto-debit-failure`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerId: `cust_mandate_${Date.now()}`,
            customerName: "Kunal Shah",
            customerPhone: "9876500001",
            customerEmail: "kunal@cred.club",
            mandateType: "UPI_AUTOPAY",
            planName: "Diamond Annual Plan",
            amountPaise: 1299900,
          }),
        });
        const mandateData = await mandateRes.json() as any;
        expect(mandateRes.status).toBe(200);
        expect(mandateData.success).toBe(true);
        expect(mandateData.retryPlan.rbiCompliant).toBe(true);

        // Query Mandates
        const listMandatesRes = await fetch(`${baseUrl}/api/mandates`);
        const listMandatesData = await listMandatesRes.json() as any;
        expect(listMandatesRes.status).toBe(200);
        expect(listMandatesData.mandates.length).toBeGreaterThan(0);

        // 2. Ingest Abandoned Checkout
        const checkoutRes = await fetch(`${baseUrl}/api/checkout/abandon`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerName: "Ananya Roy",
            customerPhone: "9876500002",
            customerEmail: "ananya@roy.org",
            cartAmountPaise: 349900,
            cartItems: [{ id: "sku_1", name: "Ergonomic Chair", pricePaise: 349900 }],
            dropOffStep: "PAYMENT_SCREEN_EXITED",
          }),
        });
        const checkoutData = await checkoutRes.json() as any;
        expect(checkoutRes.status).toBe(200);
        expect(checkoutData.success).toBe(true);
        expect(checkoutData.recoveryLink.recoveryUrl).toContain("/checkout/restore/");

        // Restore Cart via Token
        const restoreRes = await fetch(`${baseUrl}/api/checkout/restore/${checkoutData.checkout.recoveryToken}`);
        const restoreData = await restoreRes.json() as any;
        expect(restoreRes.status).toBe(200);
        expect(restoreData.restored).toBe(true);
        expect(restoreData.cartAmountPaise).toBe(349900);
        expect(restoreData.cartItems.length).toBe(1);

        // 3. Ingest B2B Invoice
        const invoiceRes = await fetch(`${baseUrl}/api/invoices/chaser/initiate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vendorId: "fintech_labs",
            clientCompany: "Apex Technologies Corp",
            contactPerson: "Deepak Chopra",
            contactEmail: "deepak@apextech.com",
            contactPhone: "9876500003",
            amountPaise: 50000000, // ₹5,00,000
            invoiceNumber: `INV-${Date.now().toString().slice(-6)}`,
            daysOverdue: 18,
            earlyDiscountPercent: 2.0,
          }),
        });
        const invoiceData = await invoiceRes.json() as any;
        expect(invoiceRes.status).toBe(200);
        expect(invoiceData.success).toBe(true);
        expect(invoiceData.chaserPlan.discountSavedPaise).toBe(1000000); // ₹10,000 discount

        // Query Invoices
        const listInvoicesRes = await fetch(`${baseUrl}/api/invoices`);
        const listInvoicesData = await listInvoicesRes.json() as any;
        expect(listInvoicesRes.status).toBe(200);
        expect(listInvoicesData.invoices.length).toBeGreaterThan(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
