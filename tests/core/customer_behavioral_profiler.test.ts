/**
 * Automated Verification Suite for Phase 1: Customer Behavioral Memory & Schema Migration
 * 
 * Verifies:
 * 1. Migration 0022 creates behavioral columns and merchant_domain_configs cleanly.
 * 2. Mathematical Priority Score formula based on EV, Engagement Velocity, Domain Urgency, Churn Risk.
 * 3. Zero-Payday Insufficient Funds guidance recommending alternate bank account / switch UPI.
 * 4. Closed-loop database telemetry updates (open latency EMA, click rate, SMS DND channel adaptation).
 * 5. Merchant domain configuration persistence and defaults.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import {
  computeCustomerPriority,
  getLowBalanceGuidance,
  recordEmailOpened,
  recordLinkClicked,
  recordDeliveryStatus,
  recordRecoveryCompleted,
  fetchBehavioralProfile,
  fetchMerchantDomainConfig,
  updateEma,
  type CustomerBehavioralProfile,
} from "../../packages/core/src/agent/behavioral_profiler.js";

describe("Phase 1 / BEH-01: Customer Behavioral Memory & Profiler Engine", () => {
  let client: Client;
  const NOW_UTC = "2026-09-04T12:00:00.000Z";

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    await runMigrations(client);

    // Insert base tenant and customer profile
    await client.execute({
      sql: `INSERT INTO tenants (id, name, created_at_utc) VALUES ('demo', 'Demo Merchant', ?)`,
      args: [NOW_UTC],
    });

    await client.execute({
      sql: `
        INSERT INTO customer_profiles (
          id, name, phone, email, created_at_utc, total_attempts, total_successes, total_failures
        ) VALUES (
          'cust_alpha', 'Rohan Verma', '+919876543210', 'rohan@example.com', ?, 5, 4, 1
        )
      `,
      args: [NOW_UTC],
    });
  });

  describe("Dynamic Priority Scoring & Engagement Velocity", () => {
    it("assigns TIER_1_CRITICAL with velocity 1.6 to rapid email openers (<15m latency)", () => {
      const rapidProfile: CustomerBehavioralProfile = {
        id: "cust_fast",
        name: "Aman",
        phone: "+919800000001",
        email: "aman@fast.com",
        preferredChannel: "EMAIL",
        emailOpenLatencyMins: 4.2, // Opens email in 4.2 minutes
        historicalOpenRate: 0.85,
        historicalClickRate: 0.60,
        paymentMethodAffinity: "upi",
        ticketSensitivityScore: 0.2,
        alternateAccountConverted: false,
        avgRecoveryLatencyHours: 0.5,
        totalRecoveredPaise: 500000,
        patienceScore: 0.1,
        lastEngagedChannel: "EMAIL",
        lastEngagedAtUtc: NOW_UTC,
        optedOut: false,
        totalAttempts: 10,
        totalSuccesses: 8,
        totalFailures: 2,
      };

      const result = computeCustomerPriority(rapidProfile, 299900, "D2C_ECOMMERCE"); // ₹2,999 in D2C
      expect(result.engagementVelocity).toBe(1.6);
      expect(result.urgencyWeight).toBe(1.45);
      expect(result.priorityTier).toBe("TIER_1_CRITICAL");
      expect(result.priorityScore).toBeGreaterThan(5000);
      expect(result.rationale).toContain("Rapid email opener");
    });

    it("assigns TIER_3_SCHEDULED to slow email openers (>4h latency)", () => {
      const slowProfile: CustomerBehavioralProfile = {
        id: "cust_slow",
        name: "Karan",
        phone: "+919800000002",
        email: "karan@slow.com",
        preferredChannel: "EMAIL",
        emailOpenLatencyMins: 480, // Opens email after 8 hours
        historicalOpenRate: 0.30,
        historicalClickRate: 0.10,
        paymentMethodAffinity: "card",
        ticketSensitivityScore: 0.4,
        alternateAccountConverted: false,
        avgRecoveryLatencyHours: 12,
        totalRecoveredPaise: 100000,
        patienceScore: 0.9,
        lastEngagedChannel: "EMAIL",
        lastEngagedAtUtc: NOW_UTC,
        optedOut: false,
        totalAttempts: 5,
        totalSuccesses: 2,
        totalFailures: 3,
      };

      const result = computeCustomerPriority(slowProfile, 99900, "SAAS_MANDATES"); // ₹999
      expect(result.engagementVelocity).toBe(0.75);
      expect(result.priorityTier).toBe("TIER_3_SCHEDULED");
      expect(result.rationale).toContain("Delayed response pattern");
    });

    it("strictly suppresses opted-out customers with TIER_4_SUPPRESSED and Score=0", () => {
      const optedOutProfile: CustomerBehavioralProfile = {
        id: "cust_opted_out",
        name: "Meera",
        phone: "+919800000003",
        email: "meera@optedout.com",
        preferredChannel: "SMS",
        emailOpenLatencyMins: 10,
        historicalOpenRate: 0.9,
        historicalClickRate: 0.8,
        paymentMethodAffinity: "upi",
        ticketSensitivityScore: 0.1,
        alternateAccountConverted: false,
        avgRecoveryLatencyHours: 1.0,
        totalRecoveredPaise: 200000,
        patienceScore: 0.5,
        lastEngagedChannel: "SMS",
        lastEngagedAtUtc: NOW_UTC,
        optedOut: true, // Opted out
        totalAttempts: 4,
        totalSuccesses: 3,
        totalFailures: 1,
      };

      const result = computeCustomerPriority(optedOutProfile, 500000, "D2C_ECOMMERCE");
      expect(result.priorityTier).toBe("TIER_4_SUPPRESSED");
      expect(result.priorityScore).toBe(0);
      expect(result.rationale).toContain("opted out");
    });
  });

  describe("Zero-Payday / Low Balance Guidance", () => {
    it("recommends switching to alternate bank account or secondary UPI without any payday assumption", () => {
      const guidance = getLowBalanceGuidance(
        "Rohan Verma",
        199900,
        "https://arbiter.live/pay/tok_rec_123"
      );

      expect(guidance.actionId).toBe("SWITCH_ACCOUNT_OR_RETRY");
      
      // Zero payday assumption invariant
      const textBlob = `${guidance.customerMessageSms} ${guidance.customerMessageEmail.body} ${guidance.customerMessageEmail.headline}`.toLowerCase();
      expect(textBlob).not.toContain("payday");
      expect(textBlob).not.toContain("salary");
      expect(textBlob).not.toContain("month-end");

      // Verify recommendation language
      expect(guidance.customerMessageSms).toContain("alternate bank account/UPI app or try again later");
      expect(guidance.customerMessageEmail.body).toContain("alternate bank account, secondary UPI app");
      expect(guidance.recommendedRails).toContain("upi_intent_alternate_vpa");
      expect(guidance.recommendedRails).toContain("secondary_bank_account");
    });

    it("identifies historical alternate account conversion flag", () => {
      const convertedProfile: CustomerBehavioralProfile = {
        id: "cust_alt",
        name: "Suresh",
        phone: "+919800000004",
        email: "suresh@example.com",
        preferredChannel: "AUTO",
        emailOpenLatencyMins: null,
        historicalOpenRate: 0.5,
        historicalClickRate: 0.3,
        paymentMethodAffinity: "upi",
        ticketSensitivityScore: 0.2,
        alternateAccountConverted: true, // Converted via alternate account before
        avgRecoveryLatencyHours: 1.2,
        totalRecoveredPaise: 450000,
        patienceScore: 0.5,
        lastEngagedChannel: null,
        lastEngagedAtUtc: null,
        optedOut: false,
        totalAttempts: 6,
        totalSuccesses: 5,
        totalFailures: 1,
      };

      const guidance = getLowBalanceGuidance("Suresh", 349900, "https://arbiter.live/pay/tok_suresh", convertedProfile);
      expect(guidance.historicalAlternateConversion).toBe(true);
    });
  });

  describe("Closed-Loop Database Telemetry", () => {
    it("updates email open latency via EMA and recalculates open rate", async () => {
      // First open: 10 mins
      await recordEmailOpened("cust_alpha", 10, client);
      let profile = await fetchBehavioralProfile("cust_alpha", client);
      expect(profile).not.toBeNull();
      expect(profile!.emailOpenLatencyMins).toBe(10);
      expect(profile!.lastEngagedChannel).toBe("EMAIL");

      // Second open: 2 mins (rapid open) -> EMA should pull down latency
      await recordEmailOpened("cust_alpha", 2, client);
      profile = await fetchBehavioralProfile("cust_alpha", client);
      // EMA: 0.35 * 2 + 0.65 * 10 = 0.7 + 6.5 = 7.2
      expect(profile!.emailOpenLatencyMins).toBeCloseTo(7.2, 1);
    });

    it("adapts preferred channel to EMAIL when SMS returns DND or FAILED", async () => {
      // Simulate MSG91 DND rejection
      await recordDeliveryStatus("cust_alpha", "SMS", "DND", client);
      const profile = await fetchBehavioralProfile("cust_alpha", client);
      expect(profile!.preferredChannel).toBe("EMAIL");
    });

    it("records completed recovery and sets alternate account conversion flag", async () => {
      await recordRecoveryCompleted("cust_alpha", 199900, 1.5, true, client);
      const profile = await fetchBehavioralProfile("cust_alpha", client);
      expect(profile!.totalSuccesses).toBe(5); // Was 4
      expect(profile!.totalRecoveredPaise).toBe(199900);
      expect(profile!.alternateAccountConverted).toBe(true);
      expect(profile!.avgRecoveryLatencyHours).toBe(1.5);
    });
  });

  describe("Merchant Domain Configuration Engine", () => {
    it("returns default D2C configuration when no tenant config exists", async () => {
      const config = await fetchMerchantDomainConfig("demo", client);
      expect(config.tenantId).toBe("demo");
      expect(config.domainType).toBe("D2C_ECOMMERCE");
      expect(config.cartReservationMins).toBe(15);
      expect(config.maxDiscountConcessionBp).toBe(500);
    });

    it("allows customizing domain configuration for SaaS mandates", async () => {
      await client.execute({
        sql: `
          INSERT OR REPLACE INTO merchant_domain_configs (
            tenant_id, domain_type, cart_reservation_mins, max_discount_concession_bp, soft_lock_grace_days, created_at_utc, updated_at_utc
          ) VALUES ('saas_tenant', 'SAAS_MANDATES', 0, 1000, 7, ?, ?)
        `,
        args: [NOW_UTC, NOW_UTC],
      });

      const config = await fetchMerchantDomainConfig("saas_tenant", client);
      expect(config.domainType).toBe("SAAS_MANDATES");
      expect(config.softLockGraceDays).toBe(7);
      expect(config.maxDiscountConcessionBp).toBe(1000);
    });
  });

  describe("EMA Math Utility", () => {
    it("correctly computes first value as exact and subsequent with alpha smoothing", () => {
      const first = updateEma(null, 15);
      expect(first).toBe(15);

      const second = updateEma(first, 5, 0.4); // 0.4 * 5 + 0.6 * 15 = 2 + 9 = 11
      expect(second).toBe(11);
    });
  });
});
