/**
 * Transaction Isolation Tests
 *
 * Proves that each payment attempt is an independent transaction.
 * Customer name, method, failure reason, and status must never leak
 * between transactions.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { processFailedPayment, recordSuccessfulPayment } from "../../app/payment_workflow.js";

process.env.BASE_URL = "http://localhost:3000";

function createTestClient(): Client {
  return createClient({ url: ":memory:" });
}

async function runMigrations(client: Client) {
  // Minimal schema for live_payment_events + customer_profiles + scheduled_outreach
  await client.execute(`
    CREATE TABLE IF NOT EXISTS customer_profiles (
      id TEXT PRIMARY KEY,
      name TEXT,
      phone TEXT,
      email TEXT,
      created_at_utc TEXT,
      total_attempts INTEGER DEFAULT 0,
      total_successes INTEGER DEFAULT 0,
      total_failures INTEGER DEFAULT 0,
      last_failure_code TEXT,
      last_failure_at_utc TEXT,
      flagged_as_suspicious INTEGER DEFAULT 0,
      vendor_decision TEXT,
      risk_score_bp INTEGER DEFAULT 0,
      total_amount_paise INTEGER DEFAULT 0
    )`);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS live_payment_events (
      id TEXT PRIMARY KEY,
      razorpay_payment_id TEXT,
      razorpay_order_id TEXT,
      customer_profile_id TEXT,
      product_name TEXT,
      amount_paise INTEGER,
      status TEXT,
      failure_code TEXT,
      failure_description TEXT,
      failure_step TEXT,
      failure_source TEXT,
      failure_reason TEXT,
      failure_class TEXT,
      ml_probability REAL,
      ml_action TEXT,
      outreach_dispatched INTEGER DEFAULT 0,
      vendor_notified INTEGER DEFAULT 0,
      vendor_decision TEXT,
      recovered_at_utc TEXT,
      created_at_utc TEXT,
      payment_method TEXT,
      card_last4 TEXT,
      card_network TEXT,
      card_issuer TEXT,
      card_type TEXT,
      card_emi INTEGER DEFAULT 0,
      vpa TEXT,
      bank_code TEXT,
      is_international INTEGER DEFAULT 0,
      acquirer_auth_code TEXT,
      acquirer_rrn TEXT,
      razorpay_token_id TEXT,
      razorpay_contact TEXT,
      razorpay_email TEXT,
      razorpay_created_at INTEGER,
      retry_count INTEGER DEFAULT 0,
      outreach_next_utc TEXT,
      outreach_channel TEXT,
      last_outreach_utc TEXT,
      customer_name TEXT,
      customer_phone TEXT,
      customer_email TEXT
    )`);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS scheduled_outreach (
      id TEXT PRIMARY KEY,
      live_payment_event_id TEXT,
      customer_profile_id TEXT,
      channel TEXT,
      scheduled_at_utc TEXT,
      executed INTEGER DEFAULT 0,
      executed_at_utc TEXT,
      status TEXT,
      error_message TEXT
    )`);
}

// Minimal outreach router for tests
const noopRouter = {
  dispatch: async () => ({ ok: true, provider: "test" }),
};

describe("Transaction Isolation", () => {
  let client: Client;

  beforeEach(async () => {
    client = createTestClient();
    await runMigrations(client);
  });

  it("Transaction 1 (Alice/UPI) is independent from Transaction 2 (Bob/Card)", async () => {
    // Create two customers
    await client.execute({
      sql: `INSERT INTO customer_profiles (id, name, phone, email, created_at_utc) VALUES (?, ?, ?, ?, ?)`,
      args: ["cust_alice", "Alice", "911111111111", "alice@test.com", "2026-09-01T00:00:00Z"],
    });
    await client.execute({
      sql: `INSERT INTO customer_profiles (id, name, phone, email, created_at_utc) VALUES (?, ?, ?, ?, ?)`,
      args: ["cust_bob", "Bob", "912222222222", "bob@test.com", "2026-09-01T00:00:00Z"],
    });

    // Transaction 1: Alice pays via UPI, fails with insufficient_funds
    const tx1 = await processFailedPayment(client, {
      razorpayPaymentId: "pay_tx1_real",
      razorpayOrderId: "order_tx1",
      amountPaise: 50000,
      failureCode: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
      failureDescription: "Insufficient balance in account",
      failureStep: "payment_authorization",
      failureSource: "customer",
      failureReason: "insufficient_funds",
      customerProfileId: "cust_alice",
      productName: "Premium Annual Plan",
      nowMs: 1000000,
      paymentMethod: "upi",
      vpa: "alice@upi",
    }, noopRouter as any);

    // Transaction 2: Bob pays via Card, fails with card_expired
    const tx2 = await processFailedPayment(client, {
      razorpayPaymentId: "pay_tx2_real",
      razorpayOrderId: "order_tx2",
      amountPaise: 99900,
      failureCode: "BAD_REQUEST_PAYMENT_CARD_EXPIRED",
      failureDescription: "Card has expired",
      failureStep: "payment_authorization",
      failureSource: "customer",
      failureReason: "card_expired",
      customerProfileId: "cust_bob",
      productName: "Monthly Basic",
      nowMs: 2000000,
      paymentMethod: "card",
      cardLast4: "4242",
      cardNetwork: "visa",
      cardType: "credit",
    }, noopRouter as any);

    // Verify: both events exist independently
    const events = await client.execute({
      sql: `SELECT * FROM live_payment_events ORDER BY created_at_utc ASC`,
      args: [],
    });
    expect(events.rows.length).toBe(2);

    const tx1Row = events.rows[0];
    const tx2Row = events.rows[1];

    // Transaction 1: Alice / UPI / insufficient_funds
    expect(String(tx1Row.customer_profile_id)).toBe("cust_alice");
    expect(String(tx1Row.customer_name)).toBe("Alice");
    expect(String(tx1Row.payment_method)).toBe("upi");
    expect(String(tx1Row.vpa)).toBe("alice@upi");
    expect(String(tx1Row.failure_code)).toBe("BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE");
    expect(String(tx1Row.failure_description)).toBe("Insufficient balance in account");
    expect(String(tx1Row.status)).toBe("failed");

    // Transaction 2: Bob / Card / card_expired
    expect(String(tx2Row.customer_profile_id)).toBe("cust_bob");
    expect(String(tx2Row.customer_name)).toBe("Bob");
    expect(String(tx2Row.payment_method)).toBe("card");
    expect(String(tx2Row.card_last4)).toBe("4242");
    expect(String(tx2Row.card_network)).toBe("visa");
    expect(String(tx2Row.failure_code)).toBe("BAD_REQUEST_PAYMENT_CARD_EXPIRED");
    expect(String(tx2Row.failure_description)).toBe("Card has expired");
    expect(String(tx2Row.status)).toBe("failed");
  });

  it("Customer name is snapshot-per-transaction, not derived from shared profile", async () => {
    // Create customer "AA"
    await client.execute({
      sql: `INSERT INTO customer_profiles (id, name, phone, email, created_at_utc) VALUES (?, ?, ?, ?, ?)`,
      args: ["cust_aa", "AA", "910000000001", "aa@test.com", "2026-09-01T00:00:00Z"],
    });

    // Transaction 1: AA fails
    await processFailedPayment(client, {
      razorpayPaymentId: "pay_aa_1",
      razorpayOrderId: "order_aa_1",
      amountPaise: 10000,
      failureCode: "insufficient_funds",
      failureDescription: "Not enough money",
      failureStep: "payment_authorization",
      failureSource: "customer",
      failureReason: "insufficient_funds",
      customerProfileId: "cust_aa",
      productName: "Monthly Basic",
      nowMs: 1000,
      paymentMethod: "upi",
      vpa: "aa@upi",
    }, noopRouter as any);

    // Now update customer profile name to "BB" (simulating another customer reusing profile)
    await client.execute({
      sql: `UPDATE customer_profiles SET name = 'BB' WHERE id = 'cust_aa'`,
      args: [],
    });

    // Transaction 2: AA fails again
    await processFailedPayment(client, {
      razorpayPaymentId: "pay_aa_2",
      razorpayOrderId: "order_aa_2",
      amountPaise: 20000,
      failureCode: "card_declined",
      failureDescription: "Bank declined card",
      failureStep: "payment_authorization",
      failureSource: "customer",
      failureReason: "card_declined",
      customerProfileId: "cust_aa",
      productName: "Premium Annual Plan",
      nowMs: 2000,
      paymentMethod: "card",
      cardLast4: "1234",
      cardNetwork: "mastercard",
    }, noopRouter as any);

    // Verify: Transaction 1 still shows "AA", Transaction 2 shows "BB" (current profile name)
    const events = await client.execute({
      sql: `SELECT customer_name, payment_method, failure_code FROM live_payment_events ORDER BY created_at_utc ASC`,
      args: [],
    });
    expect(events.rows.length).toBe(2);
    expect(String(events.rows[0].customer_name)).toBe("AA"); // Snapshot at time of TX1
    expect(String(events.rows[1].customer_name)).toBe("BB"); // Snapshot at time of TX2 (profile was updated)
  });

  it("Webhook for Transaction A does not mutate Transaction B", async () => {
    await client.execute({
      sql: `INSERT INTO customer_profiles (id, name, phone, email, created_at_utc) VALUES (?, ?, ?, ?, ?)`,
      args: ["cust_1", "User1", "911111111111", "user1@test.com", "2026-09-01T00:00:00Z"],
    });
    await client.execute({
      sql: `INSERT INTO customer_profiles (id, name, phone, email, created_at_utc) VALUES (?, ?, ?, ?, ?)`,
      args: ["cust_2", "User2", "912222222222", "user2@test.com", "2026-09-01T00:00:00Z"],
    });

    // Transaction 1: User1 fails
    const tx1Result = await processFailedPayment(client, {
      razorpayPaymentId: "pay_user1",
      razorpayOrderId: "order_user1",
      amountPaise: 10000,
      failureCode: "insufficient_funds",
      failureDescription: "Not enough money",
      failureStep: "payment_authorization",
      failureSource: "customer",
      failureReason: "insufficient_funds",
      customerProfileId: "cust_1",
      productName: "Monthly Basic",
      nowMs: 1000,
      paymentMethod: "upi",
      vpa: "user1@upi",
    }, noopRouter as any);

    // Transaction 2: User2 fails
    const tx2Result = await processFailedPayment(client, {
      razorpayPaymentId: "pay_user2",
      razorpayOrderId: "order_user2",
      amountPaise: 50000,
      failureCode: "card_expired",
      failureDescription: "Card expired",
      failureStep: "payment_authorization",
      failureSource: "customer",
      failureReason: "card_expired",
      customerProfileId: "cust_2",
      productName: "Premium Annual Plan",
      nowMs: 2000,
      paymentMethod: "card",
      cardLast4: "9999",
      cardNetwork: "amex",
    }, noopRouter as any);

    // Verify: each event has its own independent data
    const event1 = await client.execute({
      sql: `SELECT * FROM live_payment_events WHERE id = ?`,
      args: [tx1Result.eventId],
    });
    const event2 = await client.execute({
      sql: `SELECT * FROM live_payment_events WHERE id = ?`,
      args: [tx2Result.eventId],
    });

    expect(event1.rows.length).toBe(1);
    expect(event2.rows.length).toBe(1);

    // Transaction 1 data is intact
    expect(String(event1.rows[0].customer_name)).toBe("User1");
    expect(String(event1.rows[0].payment_method)).toBe("upi");
    expect(String(event1.rows[0].vpa)).toBe("user1@upi");
    expect(String(event1.rows[0].failure_code)).toBe("insufficient_funds");
    expect(Number(event1.rows[0].amount_paise)).toBe(10000);

    // Transaction 2 data is intact
    expect(String(event2.rows[0].customer_name)).toBe("User2");
    expect(String(event2.rows[0].payment_method)).toBe("card");
    expect(String(event2.rows[0].card_last4)).toBe("9999");
    expect(String(event2.rows[0].failure_code)).toBe("card_expired");
    expect(Number(event2.rows[0].amount_paise)).toBe(50000);
  });

  it("Same payment method used by different customers stays independent", async () => {
    await client.execute({
      sql: `INSERT INTO customer_profiles (id, name, phone, email, created_at_utc) VALUES (?, ?, ?, ?, ?)`,
      args: ["cust_x", "UserX", "911111111111", "x@test.com", "2026-09-01T00:00:00Z"],
    });
    await client.execute({
      sql: `INSERT INTO customer_profiles (id, name, phone, email, created_at_utc) VALUES (?, ?, ?, ?, ?)`,
      args: ["cust_y", "UserY", "912222222222", "y@test.com", "2026-09-01T00:00:00Z"],
    });

    // Both users pay via same card number
    const txX = await processFailedPayment(client, {
      razorpayPaymentId: "pay_x",
      razorpayOrderId: "order_x",
      amountPaise: 10000,
      failureCode: "insufficient_funds",
      failureDescription: "Not enough",
      failureStep: "payment_authorization",
      failureSource: "customer",
      failureReason: "insufficient_funds",
      customerProfileId: "cust_x",
      productName: "Monthly Basic",
      nowMs: 1000,
      paymentMethod: "card",
      cardLast4: "4242",
      cardNetwork: "visa",
    }, noopRouter as any);

    const txY = await processFailedPayment(client, {
      razorpayPaymentId: "pay_y",
      razorpayOrderId: "order_y",
      amountPaise: 20000,
      failureCode: "card_declined",
      failureDescription: "Declined",
      failureStep: "payment_authorization",
      failureSource: "customer",
      failureReason: "card_declined",
      customerProfileId: "cust_y",
      productName: "Premium Annual Plan",
      nowMs: 2000,
      paymentMethod: "card",
      cardLast4: "4242",
      cardNetwork: "visa",
    }, noopRouter as any);

    // Same card, different customers, different failures
    const eventX = await client.execute({
      sql: `SELECT customer_name, payment_method, failure_code, failure_description, amount_paise FROM live_payment_events WHERE id = ?`,
      args: [txX.eventId],
    });
    const eventY = await client.execute({
      sql: `SELECT customer_name, payment_method, failure_code, failure_description, amount_paise FROM live_payment_events WHERE id = ?`,
      args: [txY.eventId],
    });

    expect(String(eventX.rows[0].customer_name)).toBe("UserX");
    expect(String(eventX.rows[0].failure_code)).toBe("insufficient_funds");
    expect(Number(eventX.rows[0].amount_paise)).toBe(10000);

    expect(String(eventY.rows[0].customer_name)).toBe("UserY");
    expect(String(eventY.rows[0].failure_code)).toBe("card_declined");
    expect(Number(eventY.rows[0].amount_paise)).toBe(20000);
  });

  it("Successful payment preserves method from original failed transaction", async () => {
    await client.execute({
      sql: `INSERT INTO customer_profiles (id, name, phone, email, created_at_utc) VALUES (?, ?, ?, ?, ?)`,
      args: ["cust_z", "UserZ", "911111111111", "z@test.com", "2026-09-01T00:00:00Z"],
    });

    // First: UserZ fails with UPI
    const failResult = await processFailedPayment(client, {
      razorpayPaymentId: "pay_z_fail",
      razorpayOrderId: "order_z_fail",
      amountPaise: 30000,
      failureCode: "insufficient_funds",
      failureDescription: "Not enough",
      failureStep: "payment_authorization",
      failureSource: "customer",
      failureReason: "insufficient_funds",
      customerProfileId: "cust_z",
      productName: "Monthly Basic",
      nowMs: 1000,
      paymentMethod: "upi",
      vpa: "userz@upi",
    }, noopRouter as any);

    // Then: UserZ succeeds on retry
    await recordSuccessfulPayment(client, {
      razorpayPaymentId: "pay_z_success",
      razorpayOrderId: "order_z_success",
      customerProfileId: "cust_z",
      amountPaise: 30000,
      productName: "Monthly Basic",
      nowMs: 2000,
      paymentMethod: "upi",
      vpa: "userz@upi",
    });

    // Verify: transaction shows captured WITH method preserved
    const event = await client.execute({
      sql: `SELECT status, payment_method, vpa, failure_code FROM live_payment_events WHERE id = ?`,
      args: [failResult.eventId],
    });
    expect(String(event.rows[0].status)).toBe("captured");
    expect(String(event.rows[0].payment_method)).toBe("upi");
    expect(String(event.rows[0].vpa)).toBe("userz@upi");
    expect(event.rows[0].failure_code).toBeNull();
  });

  it("What Happened is independently generated per transaction", async () => {
    await client.execute({
      sql: `INSERT INTO customer_profiles (id, name, phone, email, created_at_utc) VALUES (?, ?, ?, ?, ?)`,
      args: ["cust_1", "User1", "911111111111", "u1@test.com", "2026-09-01T00:00:00Z"],
    });

    // Different failure codes produce different descriptions
    const tx1 = await processFailedPayment(client, {
      razorpayPaymentId: "pay_1",
      razorpayOrderId: "order_1",
      amountPaise: 10000,
      failureCode: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
      failureDescription: "Insufficient balance",
      failureStep: "payment_authorization",
      failureSource: "customer",
      failureReason: "insufficient_funds",
      customerProfileId: "cust_1",
      productName: "Monthly Basic",
      nowMs: 1000,
    }, noopRouter as any);

    const tx2 = await processFailedPayment(client, {
      razorpayPaymentId: "pay_2",
      razorpayOrderId: "order_2",
      amountPaise: 20000,
      failureCode: "BAD_REQUEST_PAYMENT_CARD_EXPIRED",
      failureDescription: "Card expired",
      failureStep: "payment_authorization",
      failureSource: "customer",
      failureReason: "card_expired",
      customerProfileId: "cust_1",
      productName: "Premium Annual Plan",
      nowMs: 2000,
    }, noopRouter as any);

    const event1 = await client.execute({
      sql: `SELECT failure_code, failure_description, failure_class FROM live_payment_events WHERE id = ?`,
      args: [tx1.eventId],
    });
    const event2 = await client.execute({
      sql: `SELECT failure_code, failure_description, failure_class FROM live_payment_events WHERE id = ?`,
      args: [tx2.eventId],
    });

    expect(String(event1.rows[0].failure_code)).toBe("BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE");
    expect(String(event1.rows[0].failure_description)).toBe("Insufficient balance");
    expect(String(event1.rows[0].failure_class)).toBe("SOFT_RETRYABLE");

    expect(String(event2.rows[0].failure_code)).toBe("BAD_REQUEST_PAYMENT_CARD_EXPIRED");
    expect(String(event2.rows[0].failure_description)).toBe("Card expired");
    expect(String(event2.rows[0].failure_class)).toBe("HARD_METHOD_DEAD");
  });
});
