/**
 * Automated Tests for Task 6.2: Autonomous Dynamic Re-Planning Agent
 * Covers:
 * 1. 5 Hard Stopping Rules & Compliance Invariants
 * 2. Perception-Action Re-Planning on Customer Portal Telemetry
 * 3. Audit Ledger Logging for Re-Planned Actions
 */
import { describe, it, expect } from "vitest";
import {
  evaluateStoppingRules,
  rePlanRecoveryAction,
  type CustomerInteractionEvent,
  type StoppingRuleContext,
} from "../../packages/core/src/agent/index.js";

describe("Task 6.2: Autonomous Dynamic Re-Planning Agent & Stopping Rules", () => {
  describe("1. Mathematical Hard Stopping Rules", () => {
    it("enforces maximum 3 touches frequency ceiling", () => {
      const ctx: StoppingRuleContext = {
        touchCount: 3,
        isOptedOut: false,
        createdAtUtc: new Date().toISOString(),
        domain: "D2C_CHECKOUT",
      };

      const result = evaluateStoppingRules(ctx);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("FREQUENCY_CEILING_EXCEEDED");
    });

    it("enforces 4-hour cooldown floor between automated touches", () => {
      const nowMs = Date.now();
      const ctx: StoppingRuleContext = {
        touchCount: 1,
        lastTouchAtUtc: new Date(nowMs - 2 * 3600 * 1000).toISOString(), // 2h ago (< 4h)
        isOptedOut: false,
        createdAtUtc: new Date(nowMs - 3 * 3600 * 1000).toISOString(),
        domain: "D2C_CHECKOUT",
        nowMs,
      };

      const result = evaluateStoppingRules(ctx);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("COOLDOWN_ACTIVE");
      expect(result.cooldownRemainingMinutes).toBeCloseTo(120, 2);
    });

    it("enforces immediate suppression on opt-out (STOP / DND)", () => {
      const ctx: StoppingRuleContext = {
        touchCount: 0,
        isOptedOut: true,
        createdAtUtc: new Date().toISOString(),
        domain: "D2C_CHECKOUT",
      };

      const result = evaluateStoppingRules(ctx);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("OPTED_OUT");
    });

    it("enforces domain-specific temporal expiration (72h for D2C)", () => {
      const nowMs = Date.now();
      const ctx: StoppingRuleContext = {
        touchCount: 1,
        isOptedOut: false,
        createdAtUtc: new Date(nowMs - 75 * 3600 * 1000).toISOString(), // 75h ago (> 72h)
        domain: "D2C_CHECKOUT",
        nowMs,
      };

      const result = evaluateStoppingRules(ctx);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("TEMPORAL_EXPIRED");
    });
  });

  describe("2. Behavioral Perception & Autonomous Re-Planning", () => {
    const daytimeMs = Date.UTC(2026, 8, 3, 8, 30, 0); // 14:00 IST (Daytime)

    it("autonomously triggers Split-Pay when high-ticket customer views portal for >20s and exits without paying", () => {
      const event: CustomerInteractionEvent = {
        eventId: "evt_test_101",
        interactionType: "PORTAL_EXITED_NO_PAY",
        dwellTimeSeconds: 35,
        timeSinceFailureMinutes: 10,
        cartAmountPaise: 499900, // ₹4,999
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

      const rePlan = rePlanRecoveryAction(event, stoppingCtx);

      expect(rePlan.action).toBe("TRIGGER_DOWNSELL_SPLIT");
      expect(rePlan.concessionType).toBe("SPLIT_PAY");
      expect(rePlan.concessionPaise).toBe(166633); // 499900 / 3
      expect(rePlan.reason).toContain("3x Split-Pay");
    });

    it("autonomously promotes 1-Tap UPI Intent when secondary card payment fails in recovery portal", () => {
      const event: CustomerInteractionEvent = {
        eventId: "evt_test_102",
        interactionType: "PAYMENT_ATTEMPTED_FAILED",
        failedPaymentMethod: "card",
        dwellTimeSeconds: 40,
        timeSinceFailureMinutes: 15,
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

      const rePlan = rePlanRecoveryAction(event, stoppingCtx);

      expect(rePlan.action).toBe("SWITCH_TO_1TAP_UPI");
      expect(rePlan.reason).toContain("1-Tap Mobile UPI Intent");
    });

    it("switches channel to WhatsApp when SMS notification remains unopened after 2 hours", () => {
      const event: CustomerInteractionEvent = {
        eventId: "evt_test_103",
        interactionType: "SMS_DELIVERED",
        timeSinceFailureMinutes: 135, // 2h 15m
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

      const rePlan = rePlanRecoveryAction(event, stoppingCtx);

      expect(rePlan.action).toBe("SWITCH_TO_WHATSAPP");
      expect(rePlan.reason).toContain("WhatsApp utility notification");
    });
  });

  describe("3. End-to-End API Interaction Ingestion", () => {
    it("ingests portal interaction telemetry and records RE_PLANNED event in audit ledger", async () => {
      const { app, dbClient } = await import("../../app/server.js");
      const { runMigrations } = await import("../../packages/core/src/db/migrate.js");
      await runMigrations(dbClient);

      const eventId = `evt_replanning_${Date.now()}`;
      const custId = `cust_replanning_${Date.now()}`;

      await dbClient.execute({
        sql: `INSERT INTO customer_profiles (id, name, phone, email, created_at_utc) VALUES (?, 'Replan User', ?, 'replan@test.com', datetime('now'))`,
        args: [custId, `97${Math.floor(10000000 + Math.random() * 90000000)}`],
      });

      await dbClient.execute({
        sql: `INSERT INTO live_payment_events (id, razorpay_payment_id, razorpay_order_id, customer_profile_id, product_name, amount_paise, status, failure_code, failure_description, retry_count, last_outreach_utc, created_at_utc)
              VALUES (?, 'pay_rp_1', 'order_rp_1', ?, 'Pro Plan', 499900, 'failed', 'BAD_REQUEST_ERROR', 'Card Limit', 1, datetime('now', '-5 hours'), datetime('now', '-5 hours'))`,
        args: [eventId, custId],
      });

      const server = app.listen(0);
      const addr = server.address() as any;
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      try {
        const res = await fetch(`${baseUrl}/api/events/${eventId}/interaction`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            interactionType: "PORTAL_EXITED_NO_PAY",
            dwellTimeSeconds: 45,
          }),
        });

        const data = await res.json() as any;
        expect(res.status).toBe(200);
        expect(data.success).toBe(true);
        expect(data.rePlanResult.action).toBe("TRIGGER_DOWNSELL_SPLIT");

        // Verify Audit Ledger Entry
        const ledger = await dbClient.execute({
          sql: `SELECT * FROM audit_ledger WHERE entity_id = ? AND event_type = 'RE_PLANNED'`,
          args: [eventId],
        });
        expect(ledger.rows.length).toBeGreaterThan(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
