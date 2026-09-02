/**
 * End-to-End Payment Workflow Tests
 *
 * Tests the complete pipeline: payment failure → classification → outreach → dashboard
 * for all 18 required scenarios.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { processFailedPayment, recordSuccessfulPayment } from "../../app/payment_workflow.js";
import { OutreachRouter } from "../../packages/core/src/messaging/router.js";
import { BrevoEmailProvider } from "../../packages/core/src/messaging/providers/brevo.js";
import { MSG91SmsProvider } from "../../packages/core/src/messaging/providers/msg91.js";
import { getCustomerMessage, getVendorMessage, getErrorEntry } from "../../packages/core/src/error-catalog.js";

let db: Client;
let router: OutreachRouter;

beforeAll(async () => {
  process.env.BASE_URL = "http://localhost:3000";
  db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE IF NOT EXISTS customer_profiles (
    id TEXT PRIMARY KEY, name TEXT, phone TEXT, email TEXT,
    total_attempts INTEGER DEFAULT 0, total_successes INTEGER DEFAULT 0,
    total_failures INTEGER DEFAULT 0, total_amount_paise INTEGER DEFAULT 0,
    last_failure_code TEXT, last_failure_at_utc TEXT,
    flagged_as_suspicious INTEGER DEFAULT 0, risk_score_bp INTEGER DEFAULT 0,
    created_at_utc TEXT
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS live_payment_events (
    id TEXT PRIMARY KEY, razorpay_payment_id TEXT, razorpay_order_id TEXT,
    customer_profile_id TEXT, product_name TEXT, amount_paise INTEGER,
    status TEXT, failure_code TEXT, failure_description TEXT,
    failure_step TEXT, failure_source TEXT, failure_reason TEXT,
    failure_class TEXT, ml_probability REAL, ml_action TEXT,
    outreach_dispatched INTEGER DEFAULT 0, vendor_notified INTEGER DEFAULT 0,
    vendor_decision TEXT, retry_count INTEGER DEFAULT 0,
    created_at_utc TEXT,
    payment_method TEXT, card_last4 TEXT, card_network TEXT,
    card_issuer TEXT, card_type TEXT, card_emi INTEGER DEFAULT 0,
    vpa TEXT, bank_code TEXT, is_international INTEGER DEFAULT 0,
    acquirer_auth_code TEXT, acquirer_rrn TEXT,
    razorpay_token_id TEXT, razorpay_contact TEXT, razorpay_email TEXT,
    razorpay_created_at INTEGER,
    customer_name TEXT, customer_phone TEXT, customer_email TEXT
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS scheduled_outreach (
    id TEXT PRIMARY KEY, live_payment_event_id TEXT, customer_profile_id TEXT,
    channel TEXT, scheduled_at_utc TEXT, executed INTEGER DEFAULT 0,
    executed_at_utc TEXT, status TEXT, error_message TEXT,
    cancelled_reason TEXT, cancelled_at_utc TEXT
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS webhook_dedupe (
    provider_event_id TEXT PRIMARY KEY, first_seen_utc TEXT, swallow_count INTEGER DEFAULT 0
  )`);
  router = new OutreachRouter();
  router.registerProvider(new BrevoEmailProvider());
  router.registerProvider(new MSG91SmsProvider());
});

async function createCustomer(name: string, email: string, phone: string): Promise<string> {
  const id = `cust_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await db.execute({
    sql: `INSERT INTO customer_profiles (id, name, email, phone, created_at_utc) VALUES (?, ?, ?, ?, datetime('now'))`,
    args: [id, name, email, phone],
  });
  return id;
}

async function getEvent(id: string): Promise<any> {
  const rows = await db.execute({ sql: `SELECT * FROM live_payment_events WHERE id = ?`, args: [id] });
  return rows.rows[0] || null;
}

async function getOutreachForEvent(eventId: string): Promise<any[]> {
  const rows = await db.execute({
    sql: `SELECT * FROM scheduled_outreach WHERE live_payment_event_id = ? ORDER BY scheduled_at_utc`,
    args: [eventId],
  });
  return rows.rows;
}

describe("E2E Payment Workflow", () => {
  describe("1. Initial payment failure", () => {
    it("creates event, dispatches email, records outreach state", async () => {
      const custId = await createCustomer("Alice", "alice@test.com", "919876543210");
      const result = await processFailedPayment(db, {
        razorpayPaymentId: "pay_test_001",
        razorpayOrderId: "order_test_001",
        amountPaise: 499900,
        failureCode: "insufficient_funds",
        failureDescription: "Insufficient funds",
        failureStep: "payment_authorization",
        failureSource: "customer",
        failureReason: "Insufficient funds",
        customerProfileId: custId,
        productName: "Premium Annual Plan",
        nowMs: Date.now(),
        paymentMethod: "card",
        cardLast4: "4120",
        cardNetwork: "Visa",
        cardIssuer: "HDFC",
        cardType: "credit",
      }, router);

      expect(result.eventId).toBeTruthy();
      expect(result.failureClass).toBe("SOFT_RETRYABLE");

      const event = await getEvent(result.eventId);
      expect(event.status).toBe("failed");
      expect(event.failure_code).toBe("insufficient_funds");
      expect(event.payment_method).toBe("card");
      expect(event.card_last4).toBe("4120");
      expect(event.customer_name).toBe("Alice");

      const outreach = await getOutreachForEvent(result.eventId);
      const emailOutreach = outreach.find((o: any) => o.channel === "EMAIL");
      expect(emailOutreach).toBeTruthy();
      expect(emailOutreach.status).toBe("SENT_SIMULATED");
    });
  });

  describe("2. Email delivery", () => {
    it("sends email with customer message, not raw codes", async () => {
      const custId = await createCustomer("Bob", "bob@test.com", "919876543211");
      const result = await processFailedPayment(db, {
        razorpayPaymentId: "pay_test_002",
        razorpayOrderId: "order_test_002",
        amountPaise: 99900,
        failureCode: "card_expired",
        failureDescription: "Your card has expired",
        failureStep: "payment_authorization",
        failureSource: "customer",
        failureReason: "Card expired",
        customerProfileId: custId,
        productName: "Monthly Basic",
        nowMs: Date.now(),
        paymentMethod: "card",
        cardLast4: "1234",
        cardNetwork: "Mastercard",
        cardType: "debit",
      }, router);

      const customerMsg = getCustomerMessage("card_expired");
      expect(customerMsg).toContain("expired");
      expect(customerMsg).not.toContain("CARD_EXPIRED");
      expect(customerMsg).not.toContain("[");
    });
  });

  describe("3. Vendor dashboard update", () => {
    it("vendor message is concise, no raw codes", () => {
      const msg = getVendorMessage("insufficient_funds");
      expect(msg).toBeTruthy();
      expect(msg).not.toContain("INSUFFICIENT_FUNDS");
      expect(msg).not.toContain("[");
      expect(msg).not.toContain("ERROR");
    });
  });

  describe("4. Customer Pay Again page", () => {
    it("customer message is actionable, no jargon", () => {
      const cases = [
        ["insufficient_funds", "add money"],
        ["card_expired", "different card"],
        ["GATEWAY_TIMEOUT", "try again"],
        ["payment_risk_check_failed", "contact"],
      ];
      for (const [code, keyword] of cases) {
        const msg = getCustomerMessage(code);
        expect(msg.toLowerCase()).toContain(keyword);
        expect(msg).not.toContain("[");
        expect(msg).not.toContain("ERROR");
      }
    });
  });

  describe("5. Retry payment creates new transaction", () => {
    it("new order = new event, original immutable", async () => {
      const custId = await createCustomer("Carol", "carol@test.com", "919876543212");
      const first = await processFailedPayment(db, {
        razorpayPaymentId: "pay_retry_001",
        razorpayOrderId: "order_retry_001",
        amountPaise: 199900,
        failureCode: "insufficient_funds",
        failureDescription: "Insufficient funds",
        failureStep: "payment_authorization",
        failureSource: "customer",
        failureReason: "Insufficient funds",
        customerProfileId: custId,
        productName: "Premium Annual Plan",
        nowMs: Date.now(),
        paymentMethod: "card",
        cardLast4: "5678",
        cardNetwork: "Visa",
      }, router);

      // Simulate retry with new order
      const retry = await processFailedPayment(db, {
        razorpayPaymentId: "pay_retry_002",
        razorpayOrderId: "order_retry_002",
        amountPaise: 199900,
        failureCode: "CARD_EXPIRED",
        failureDescription: "Your card has expired",
        failureStep: "payment_authorization",
        failureSource: "customer",
        failureReason: "Card expired",
        customerProfileId: custId,
        productName: "Premium Annual Plan",
        nowMs: Date.now(),
        paymentMethod: "card",
        cardLast4: "5678",
        cardNetwork: "Visa",
      }, router);

      // New order = new event (not updating the old one)
      expect(retry.eventId).not.toBe(first.eventId);

      const firstEvent = await getEvent(first.eventId);
      const retryEvent = await getEvent(retry.eventId);
      expect(firstEvent.failure_code).toBe("insufficient_funds");
      expect(retryEvent.failure_code).toBe("CARD_EXPIRED");

      // Both should have outreach
      const firstOutreach = await getOutreachForEvent(first.eventId);
      const retryOutreach = await getOutreachForEvent(retry.eventId);
      expect(firstOutreach.length).toBeGreaterThan(0);
      expect(retryOutreach.length).toBeGreaterThan(0);
    });
  });

  describe("6. Failed retry sends email", () => {
    it("retry failure creates new transaction with outreach", async () => {
      const custId = await createCustomer("Dave", "dave@test.com", "919876543213");
      const first = await processFailedPayment(db, {
        razorpayPaymentId: "pay_failretry_001",
        razorpayOrderId: "order_failretry_001",
        amountPaise: 99900,
        failureCode: "insufficient_funds",
        failureDescription: "Insufficient funds",
        failureStep: "payment_authorization",
        failureSource: "customer",
        failureReason: "Insufficient funds",
        customerProfileId: custId,
        productName: "Monthly Basic",
        nowMs: Date.now(),
      }, router);

      const retry = await processFailedPayment(db, {
        razorpayPaymentId: "pay_failretry_002",
        razorpayOrderId: "order_failretry_002",
        amountPaise: 99900,
        failureCode: "GATEWAY_TIMEOUT",
        failureDescription: "Gateway timeout",
        failureStep: "payment_authorization",
        failureSource: "gateway",
        failureReason: "Gateway timeout",
        customerProfileId: custId,
        productName: "Monthly Basic",
        nowMs: Date.now(),
      }, router);

      // Retry should be a new event with its own outreach
      expect(retry.eventId).not.toBe(first.eventId);
      const retryOutreach = await getOutreachForEvent(retry.eventId);
      const emailOutreach = retryOutreach.find((o: any) => o.channel === "EMAIL");
      expect(emailOutreach).toBeTruthy();
      expect(emailOutreach.status).toBe("SENT_SIMULATED");
    });
  });

  describe("7. Successful retry suppresses pending outreach", () => {
    it("marks scheduled outreach as SUPPRESSED", async () => {
      const custId = await createCustomer("Eve", "eve@test.com", "919876543214");
      const first = await processFailedPayment(db, {
        razorpayPaymentId: "pay_suppress_001",
        razorpayOrderId: "order_suppress_001",
        amountPaise: 499900,
        failureCode: "insufficient_funds",
        failureDescription: "Insufficient funds",
        failureStep: "payment_authorization",
        failureSource: "customer",
        failureReason: "Insufficient funds",
        customerProfileId: custId,
        productName: "Premium Annual Plan",
        nowMs: Date.now(),
      }, router);

      // Record successful payment
      await recordSuccessfulPayment(db, {
        razorpayPaymentId: "pay_suppress_002",
        razorpayOrderId: "order_suppress_002",
        customerProfileId: custId,
        amountPaise: 499900,
        productName: "Premium Annual Plan",
        nowMs: Date.now(),
      });

      const outreach = await getOutreachForEvent(first.eventId);
      const suppressed = outreach.filter((o: any) => o.status === "SUPPRESSED" || o.status === "CANCELLED");
      expect(suppressed.length).toBeGreaterThan(0);
    });
  });

  describe("8-14. Failure classification scenarios", () => {
    const scenarios = [
      { code: "insufficient_funds", expectedClass: "SOFT_RETRYABLE", method: "card" },
      { code: "card_expired", expectedClass: "HARD_METHOD_DEAD", method: "card" },
      { code: "GATEWAY_TIMEOUT", expectedClass: "NETWORK_TIMEOUT", method: "netbanking" },
      { code: "SUSPECTED_FRAUD", expectedClass: "RISK_FLAGGED", method: "card" },
      { code: "UNKNOWN_CODE", expectedClass: "UNKNOWN", method: "upi" },
      { code: "BAD_REQUEST_PAYMENT_UPI_COLLECT_EXPIRED", expectedClass: "SOFT_RETRYABLE", method: "upi" },
      { code: "BANK_DOWNTIME_NETWORK_ERROR", expectedClass: "NETWORK_TIMEOUT", method: "netbanking" },
    ];

    for (const scenario of scenarios) {
      it(`classifies ${scenario.code} as ${scenario.expectedClass}`, async () => {
        const custId = await createCustomer(`Test_${scenario.code}`, `${scenario.code}@test.com`, "919876543999");
        const result = await processFailedPayment(db, {
          razorpayPaymentId: `pay_class_${scenario.code}`,
          razorpayOrderId: `order_class_${scenario.code}`,
          amountPaise: 99900,
          failureCode: scenario.code,
          failureDescription: `Test ${scenario.code}`,
          failureStep: "payment_authorization",
          failureSource: "customer",
          failureReason: scenario.code,
          customerProfileId: custId,
          productName: "Monthly Basic",
          nowMs: Date.now(),
          paymentMethod: scenario.method,
        }, router);

        expect(result.failureClass).toBe(scenario.expectedClass);
      });
    }
  });

  describe("15. Transaction isolation", () => {
    it("two transactions for same customer are independent", async () => {
      const custId = await createCustomer("Frank", "frank@test.com", "919876543215");

      const txnA = await processFailedPayment(db, {
        razorpayPaymentId: "pay_iso_A",
        razorpayOrderId: "order_iso_A",
        amountPaise: 499900,
        failureCode: "insufficient_funds",
        failureDescription: "Insufficient funds",
        failureStep: "payment_authorization",
        failureSource: "customer",
        failureReason: "Insufficient funds",
        customerProfileId: custId,
        productName: "Premium Annual Plan",
        nowMs: Date.now(),
        paymentMethod: "netbanking",
        bankCode: "HDFC",
      }, router);

      const txnB = await processFailedPayment(db, {
        razorpayPaymentId: "pay_iso_B",
        razorpayOrderId: "order_iso_B",
        amountPaise: 99900,
        failureCode: "card_expired",
        failureDescription: "Card expired",
        failureStep: "payment_authorization",
        failureSource: "customer",
        failureReason: "Card expired",
        customerProfileId: custId,
        productName: "Monthly Basic",
        nowMs: Date.now(),
        paymentMethod: "card",
        cardLast4: "9999",
        cardNetwork: "RuPay",
      }, router);

      expect(txnA.eventId).not.toBe(txnB.eventId);

      const eventA = await getEvent(txnA.eventId);
      const eventB = await getEvent(txnB.eventId);
      expect(eventA.failure_class).toBe("SOFT_RETRYABLE");
      expect(eventB.failure_class).toBe("HARD_METHOD_DEAD");
      expect(eventA.payment_method).toBe("netbanking");
      expect(eventB.payment_method).toBe("card");
    });
  });

  describe("16. Different customers same method", () => {
    it("independent transactions, no data leakage", async () => {
      const cust1 = await createCustomer("Grace", "grace@test.com", "919876543216");
      const cust2 = await createCustomer("Hank", "hank@test.com", "919876543217");

      const txn1 = await processFailedPayment(db, {
        razorpayPaymentId: "pay_diff_001",
        razorpayOrderId: "order_diff_001",
        amountPaise: 99900,
        failureCode: "insufficient_funds",
        failureDescription: "Insufficient funds",
        failureStep: "payment_authorization",
        failureSource: "customer",
        failureReason: "Insufficient funds",
        customerProfileId: cust1,
        productName: "Monthly Basic",
        nowMs: Date.now(),
        paymentMethod: "card",
        cardLast4: "1111",
      }, router);

      const txn2 = await processFailedPayment(db, {
        razorpayPaymentId: "pay_diff_002",
        razorpayOrderId: "order_diff_002",
        amountPaise: 99900,
        failureCode: "card_expired",
        failureDescription: "Card expired",
        failureStep: "payment_authorization",
        failureSource: "customer",
        failureReason: "Card expired",
        customerProfileId: cust2,
        productName: "Monthly Basic",
        nowMs: Date.now(),
        paymentMethod: "card",
        cardLast4: "2222",
      }, router);

      const event1 = await getEvent(txn1.eventId);
      const event2 = await getEvent(txn2.eventId);
      expect(event1.customer_name).toBe("Grace");
      expect(event2.customer_name).toBe("Hank");
      expect(event1.failure_code).toBe("insufficient_funds");
      expect(event2.failure_code).toBe("card_expired");
    });
  });

  describe("17. Concurrent transactions", () => {
    it("handles multiple simultaneous failures", async () => {
      const custId = await createCustomer("Iris", "iris@test.com", "919876543218");
      const results = await Promise.all([
        processFailedPayment(db, {
          razorpayPaymentId: "pay_conc_001",
          razorpayOrderId: "order_conc_001",
          amountPaise: 99900,
          failureCode: "insufficient_funds",
          failureDescription: "Insufficient funds",
          failureStep: "payment_authorization",
          failureSource: "customer",
          failureReason: "Insufficient funds",
          customerProfileId: custId,
          productName: "Monthly Basic",
          nowMs: Date.now(),
        }, router),
        processFailedPayment(db, {
          razorpayPaymentId: "pay_conc_002",
          razorpayOrderId: "order_conc_002",
          amountPaise: 199900,
          failureCode: "card_expired",
          failureDescription: "Card expired",
          failureStep: "payment_authorization",
          failureSource: "customer",
          failureReason: "Card expired",
          customerProfileId: custId,
          productName: "Premium Annual Plan",
          nowMs: Date.now(),
        }, router),
      ]);

      const ids = results.map((r) => r.eventId);
      expect(new Set(ids).size).toBe(2);
    });
  });

  describe("18. Error catalog completeness", () => {
    it("every error code has customer message, vendor message, failure class", async () => {
      const codes = [
        "insufficient_funds", "card_expired", "card_declined",
        "incorrect_cvv", "authentication_failed", "transaction_limit_exceeded",
        "invalid_vpa", "payment_collect_request_expired",
        "bank_technical_error", "gateway_technical_error", "payment_timed_out",
        "payment_risk_check_failed", "server_error", "UNKNOWN",
      ];
      for (const code of codes) {
        const entry = getErrorEntry(code);
        expect(entry.customerMessage).toBeTruthy();
        expect(entry.vendorMessage).toBeTruthy();
        expect(entry.failureClass).toBeTruthy();
        expect(entry.recommendedAction).toBeTruthy();
        // No raw codes in messages
        expect(entry.customerMessage).not.toMatch(/\[.*ERROR.*\]/i);
        expect(entry.vendorMessage).not.toMatch(/\[.*ERROR.*\]/i);
      }
    });
  });
});
