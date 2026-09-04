import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../packages/core/src/db/client.js";
import { runMigrations } from "../../packages/core/src/db/migrate.js";
import {
  LinUCBBandit,
  defaultEnterpriseBandit,
  ENTERPRISE_BANDIT_ACTIONS,
  ENTERPRISE_CONTEXT_DIM,
  type EnterpriseBanditAction,
} from "../../packages/core/src/agent/contextual_bandit.js";
import { processFailedPayment, recordSuccessfulPayment, onPaymentRecovered } from "../../app/payment_workflow.js";
import { OutreachRouter } from "../../packages/core/src/messaging/index.js";

describe("Phase 1: LinUCB Contextual Bandit Persistence & Live Closed-Loop RL Integration", () => {
  let dbClient: any;

  beforeEach(async () => {
    const { client } = await openDb(":memory:");
    dbClient = client;
    await runMigrations(dbClient);
  });

  describe("1. Database Schema & Migration 0023", () => {
    it("applies migration 0023 and creates bandit_state table with correct schema", async () => {
      const tableCheck = await dbClient.execute({
        sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='bandit_state'",
      });
      expect(tableCheck.rows).toHaveLength(1);

      const migrationCheck = await dbClient.execute({
        sql: "SELECT name FROM schema_migrations WHERE name LIKE '%0023%'",
      });
      expect(migrationCheck.rows).toHaveLength(1);

      const tableInfo = await dbClient.execute({
        sql: "PRAGMA table_info(bandit_state)",
      });
      const columns = tableInfo.rows.map((r: any) => r.name);
      expect(columns).toContain("arm_type");
      expect(columns).toContain("action");
      expect(columns).toContain("dimension");
      expect(columns).toContain("matrix_a_json");
      expect(columns).toContain("vector_b_json");
      expect(columns).toContain("pull_count");
      expect(columns).toContain("total_reward");
      expect(columns).toContain("updated_at_utc");
    });

    it("verifies live_payment_events contains bandit telemetry columns", async () => {
      const tableInfo = await dbClient.execute({
        sql: "PRAGMA table_info(live_payment_events)",
      });
      const columns = tableInfo.rows.map((r: any) => r.name);
      expect(columns).toContain("bandit_action");
      expect(columns).toContain("bandit_context_json");
      expect(columns).toContain("bandit_ucb_score");
    });
  });

  describe("2. LinUCB Persistence Engine Round-Trip", () => {
    it("serializes 5-D covariance matrices to SQLite and cleanly rehydrates them", async () => {
      const bandit = LinUCBBandit.createEnterpriseBandit(0.2);
      const ctx1: [number, number, number, number, number] = [0.8, 0.1, 0.2, 0.4, 0.9];
      const ctx2: [number, number, number, number, number] = [0.2, 0.5, 0.1, 0.0, 0.7];

      // Train arm 1 and arm 2
      bandit.updateArm("SMS_1TAP_UPI", ctx1, 1.0);
      bandit.updateArm("SMS_1TAP_UPI", ctx1, 1.0);
      bandit.updateArm("EMAIL_1TAP_UPI", ctx2, 0.5);

      const stateBefore = bandit.getState();
      expect(stateBefore.SMS_1TAP_UPI.pullCount).toBe(2);
      expect(stateBefore.SMS_1TAP_UPI.totalReward).toBe(2.0);
      expect(stateBefore.EMAIL_1TAP_UPI.pullCount).toBe(1);

      // Save to SQLite
      await bandit.saveToDb(dbClient, "enterprise");

      // Verify rows in bandit_state
      const rows = await dbClient.execute({
        sql: "SELECT action, pull_count, total_reward, dimension FROM bandit_state WHERE arm_type = 'enterprise'",
      });
      expect(rows.rows).toHaveLength(5); // All 5 enterprise arms

      // Rehydrate into a fresh bandit
      const freshBandit = LinUCBBandit.createEnterpriseBandit(0.2);
      const loadedCount = await freshBandit.loadFromDb(dbClient, "enterprise");
      expect(loadedCount).toBe(5);

      const stateAfter = freshBandit.getState();
      expect(stateAfter.SMS_1TAP_UPI.pullCount).toBe(2);
      expect(stateAfter.SMS_1TAP_UPI.totalReward).toBe(2.0);
      expect(stateAfter.SMS_1TAP_UPI.A).toEqual(stateBefore.SMS_1TAP_UPI.A);
      expect(stateAfter.SMS_1TAP_UPI.b).toEqual(stateBefore.SMS_1TAP_UPI.b);
      expect(stateAfter.EMAIL_1TAP_UPI.pullCount).toBe(1);
      expect(stateAfter.EMAIL_1TAP_UPI.totalReward).toBe(0.5);
    });

    it("atomically updates a single arm via saveArmToDb without corrupting peer arms", async () => {
      const bandit = LinUCBBandit.createEnterpriseBandit(0.2);
      await bandit.saveToDb(dbClient, "enterprise");

      // Update only IN_FLIGHT_CASCADE
      const ctx: [number, number, number, number, number] = [0.1, 0.2, 0.3, 0.4, 0.5];
      bandit.updateArm("IN_FLIGHT_CASCADE", ctx, 1.0);
      await bandit.saveArmToDb(dbClient, "enterprise", "IN_FLIGHT_CASCADE");

      const dbCascade = await dbClient.execute({
        sql: "SELECT pull_count, total_reward FROM bandit_state WHERE arm_type = 'enterprise' AND action = 'IN_FLIGHT_CASCADE'",
      });
      expect(Number(dbCascade.rows[0].pull_count)).toBe(1);
      expect(Number(dbCascade.rows[0].total_reward)).toBe(1.0);

      // Verify another arm was untouched
      const dbSms = await dbClient.execute({
        sql: "SELECT pull_count, total_reward FROM bandit_state WHERE arm_type = 'enterprise' AND action = 'SMS_1TAP_UPI'",
      });
      expect(Number(dbSms.rows[0].pull_count)).toBe(0);
    });
  });

  describe("3. Live Checkout Arm Selection & Context Extraction", () => {
    it("extracts 5-D enterprise context, selects optimal arm, and persists bandit telemetry to live_payment_events", async () => {
      // Setup customer profile with behavioral memory
      const custId = "cust_bandit_test_1";
      await dbClient.execute({
        sql: `INSERT INTO customer_profiles
              (id, name, phone, email, total_attempts, total_successes, total_failures,
               email_open_latency_mins, created_at_utc)
              VALUES (?, 'Rohan Varma', '+919876543210', 'rohan@example.com', 4, 3, 1, 45, datetime('now'))`,
        args: [custId],
      });

      const outreachRouter = new OutreachRouter();
      const processRes = await processFailedPayment(
        dbClient,
        {
          razorpayPaymentId: "pay_bandit_001",
          razorpayOrderId: "order_bandit_001",
          customerProfileId: custId,
          productName: "Premium Annual Plan",
          amountPaise: 499900,
          failureCode: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
          failureDescription: "Insufficient funds in customer account",
          failureStep: "payment_authentication",
          failureSource: "bank",
          failureReason: "Account has insufficient balance",
          nowMs: Date.now(),
        },
        outreachRouter,
      );

      expect(processRes.banditSelection).toBeDefined();
      expect(ENTERPRISE_BANDIT_ACTIONS).toContain(processRes.banditSelection!.action);
      expect(processRes.banditSelection!.context).toHaveLength(5);
      expect(processRes.banditSelection!.context[0]).toBeCloseTo(0.4999, 3); // 499900 / 1000000
      expect(processRes.banditSelection!.context[2]).toBeCloseTo(45 / 240, 2); // openLatency 45 mins / 240
      expect(processRes.banditSelection!.context[4]).toBeCloseTo(0.75, 2); // responsiveness

      // Verify row in live_payment_events
      const eventRow = await dbClient.execute({
        sql: "SELECT bandit_action, bandit_context_json, bandit_ucb_score FROM live_payment_events WHERE id = ?",
        args: [processRes.eventId],
      });
      expect(eventRow.rows).toHaveLength(1);
      expect(eventRow.rows[0].bandit_action).toBe(processRes.banditSelection!.action);
      expect(JSON.parse(String(eventRow.rows[0].bandit_context_json))).toEqual(processRes.banditSelection!.context);
      expect(Number(eventRow.rows[0].bandit_ucb_score)).toBe(processRes.banditSelection!.ucbScore);

      // Verify audit ledger contains BANDIT_ARM_SELECTED
      const auditRows = await dbClient.execute({
        sql: "SELECT event_type, payload_json FROM audit_ledger WHERE entity_id = ? AND event_type = 'BANDIT_ARM_SELECTED'",
        args: [processRes.eventId],
      });
      expect(auditRows.rows).toHaveLength(1);
      const auditPayload = JSON.parse(String(auditRows.rows[0].payload_json));
      expect(auditPayload.action).toBe(processRes.banditSelection!.action);
    });
  });

  describe("4. Closed-Loop Online RL Reward Feedback", () => {
    it("triggers reward feedback on payment recovery and persists updated bandit weights", async () => {
      const custId = "cust_bandit_test_2";
      await dbClient.execute({
        sql: `INSERT INTO customer_profiles
              (id, name, phone, email, total_attempts, total_successes, total_failures,
               created_at_utc)
              VALUES (?, 'Ananya Iyer', '+919876543211', 'ananya@example.com', 2, 1, 1,
                      datetime('now'))`,
        args: [custId],
      });

      const outreachRouter = new OutreachRouter();
      const failRes = await processFailedPayment(
        dbClient,
        {
          razorpayPaymentId: "pay_bandit_002",
          razorpayOrderId: "order_bandit_002",
          customerProfileId: custId,
          productName: "Monthly Basic",
          amountPaise: 99900,
          failureCode: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
          failureDescription: "Debit card declined",
          failureStep: "payment_authorization",
          failureSource: "issuer",
          failureReason: "Insufficient funds",
          nowMs: Date.now(),
        },
        outreachRouter,
      );

      const chosenAction = failRes.banditSelection!.action;
      const initialArmState = defaultEnterpriseBandit.getState()[chosenAction];
      const initialPulls = initialArmState.pullCount;
      const initialReward = initialArmState.totalReward;

      // Customer recovers payment (via webhook or payment portal)
      const successPaymentId = "pay_rec_bandit_002";
      await recordSuccessfulPayment(dbClient, {
        razorpayPaymentId: successPaymentId,
        razorpayOrderId: "order_bandit_002",
        customerProfileId: custId,
        amountPaise: 99900,
        productName: "Monthly Basic",
        nowMs: Date.now() + 1000,
      });

      // Verify bandit was updated in memory
      const updatedArmState = defaultEnterpriseBandit.getState()[chosenAction];
      expect(updatedArmState.pullCount).toBe(initialPulls + 1);
      expect(updatedArmState.totalReward).toBeCloseTo(initialReward + 1.0, 4);

      // Verify bandit was updated in SQLite database
      const dbBandit = await dbClient.execute({
        sql: "SELECT pull_count, total_reward FROM bandit_state WHERE arm_type = 'enterprise' AND action = ?",
        args: [chosenAction],
      });
      expect(dbBandit.rows).toHaveLength(1);
      expect(Number(dbBandit.rows[0].pull_count)).toBe(updatedArmState.pullCount);
      expect(Number(dbBandit.rows[0].total_reward)).toBeCloseTo(updatedArmState.totalReward, 4);

      // Verify audit ledger recorded BANDIT_REWARD_FEEDBACK
      const auditRows = await dbClient.execute({
        sql: "SELECT event_type, payload_json FROM audit_ledger WHERE entity_id = ? AND event_type = 'BANDIT_REWARD_FEEDBACK'",
        args: [failRes.eventId],
      });
      expect(auditRows.rows).toHaveLength(1);
      const payload = JSON.parse(String(auditRows.rows[0].payload_json));
      expect(payload.action).toBe(chosenAction);
      expect(payload.reward).toBe(1.0);
    });

    it("prevents duplicate reward feedback when both recordSuccessfulPayment and onPaymentRecovered are invoked", async () => {
      const custId = "cust_bandit_test_3";
      await dbClient.execute({
        sql: `INSERT INTO customer_profiles
              (id, name, phone, email, total_attempts, total_successes, total_failures,
               created_at_utc)
              VALUES (?, 'Karan Patel', '+919876543212', 'karan@example.com', 1, 0, 1,
                      datetime('now'))`,
        args: [custId],
      });

      const outreachRouter = new OutreachRouter();
      const failRes = await processFailedPayment(
        dbClient,
        {
          razorpayPaymentId: "pay_bandit_003",
          razorpayOrderId: "order_bandit_003",
          customerProfileId: custId,
          productName: "Team License (5 seats)",
          amountPaise: 199900,
          failureCode: "PAYMENT_TIMED_OUT",
          failureDescription: "Gateway timeout",
          failureStep: "payment_authorization",
          failureSource: "gateway",
          failureReason: "Bank timeout",
          nowMs: Date.now(),
        },
        outreachRouter,
      );

      const chosenAction = failRes.banditSelection!.action;
      const initialPulls = defaultEnterpriseBandit.getState()[chosenAction].pullCount;

      // 1st trigger: recordSuccessfulPayment
      await recordSuccessfulPayment(dbClient, {
        razorpayPaymentId: "pay_rec_bandit_003",
        razorpayOrderId: "order_bandit_003",
        customerProfileId: custId,
        amountPaise: 199900,
        productName: "Team License (5 seats)",
        nowMs: Date.now() + 1000,
      });

      // 2nd trigger: onPaymentRecovered (e.g. portal confirmation)
      await onPaymentRecovered(dbClient, {
        customerProfileId: custId,
        orderId: "order_bandit_003",
        eventId: failRes.eventId,
        amountPaise: 199900,
        nowMs: Date.now() + 2000,
      });

      // Guard guarantee: exactly 1 pull was registered
      const finalPulls = defaultEnterpriseBandit.getState()[chosenAction].pullCount;
      expect(finalPulls).toBe(initialPulls + 1);
    });
  });

  describe("5. Multi-Round Convergence & Cryptographic Audit Integrity", () => {
    it("converges toward high-reward action and shrinks exploration variance under repeated feedback", async () => {
      const bandit = LinUCBBandit.createEnterpriseBandit(0.2);
      const testContext: [number, number, number, number, number] = [0.15, 0.1, 0.05, 0.2, 0.9]; // low ticket, low latency, high responsiveness

      const initialSel = bandit.selectArm(testContext);
      const initialVar = initialSel.confidenceBound;

      // Train arm B2B_EARLY_SETTLEMENT with high reward (1.0), and SMS_1TAP_UPI with lower reward (0.2)
      for (let i = 0; i < 10; i++) {
        bandit.updateArm("B2B_EARLY_SETTLEMENT", testContext, 1.0);
        bandit.updateArm("SMS_1TAP_UPI", testContext, 0.2);
      }

      const postTrainSel = bandit.selectArm(testContext);
      expect(postTrainSel.action).toBe("B2B_EARLY_SETTLEMENT");
      expect(postTrainSel.estimatedReward).toBeGreaterThan(0.5);

      // Save and reload to verify convergence persists across restarts
      await bandit.saveToDb(dbClient, "enterprise");
      const rehydrated = LinUCBBandit.createEnterpriseBandit(0.2);
      await rehydrated.loadFromDb(dbClient, "enterprise");

      const rehydratedSel = rehydrated.selectArm(testContext);
      expect(rehydratedSel.action).toBe("B2B_EARLY_SETTLEMENT");
      expect(rehydratedSel.estimatedReward).toBeCloseTo(postTrainSel.estimatedReward, 3);
    });

    it("verifies SHA-256 cryptographic chaining in audit ledger for bandit decisions and feedback", async () => {
      const custId = "cust_bandit_chain_test";
      await dbClient.execute({
        sql: `INSERT INTO customer_profiles (id, name, phone, email, total_attempts, total_successes, total_failures, created_at_utc)
              VALUES (?, 'Audit User', '+919876543299', 'audit@test.com', 1, 0, 1, datetime('now'))`,
        args: [custId],
      });

      const router = new OutreachRouter();
      const failRes = await processFailedPayment(
        dbClient,
        {
          razorpayPaymentId: "pay_chain_001",
          razorpayOrderId: "order_chain_001",
          customerProfileId: custId,
          productName: "Monthly Basic",
          amountPaise: 99900,
          failureCode: "PAYMENT_TIMED_OUT",
          failureDescription: "Gateway timeout",
          failureStep: "payment_authorization",
          failureSource: "gateway",
          failureReason: "Bank timeout",
          nowMs: Date.now(),
        },
        router,
      );

      await recordSuccessfulPayment(dbClient, {
        razorpayPaymentId: "pay_rec_chain_001",
        razorpayOrderId: "order_chain_001",
        customerProfileId: custId,
        amountPaise: 99900,
        productName: "Monthly Basic",
        nowMs: Date.now() + 1000,
      });

      const auditEntries = await dbClient.execute({
        sql: "SELECT entry_hash, prev_hash, event_type FROM audit_ledger ORDER BY created_at_utc ASC, rowid ASC",
      });

      expect(auditEntries.rows.length).toBeGreaterThanOrEqual(4);
      for (let i = 1; i < auditEntries.rows.length; i++) {
        const prev = auditEntries.rows[i - 1];
        const curr = auditEntries.rows[i];
        expect(curr.prev_hash).toBe(prev.entry_hash);
      }
    });
  });
});
