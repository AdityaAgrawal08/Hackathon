import { describe, it, expect } from "vitest";
import { diagnosePaymentFailure } from "../../packages/core/src/decide/diagnostics.js";

describe("Task DIAG-09: Deep Razorpay Banking Diagnostics Engine", () => {
  it("diagnoses customer low balance (ISO-8583 Code 51) with prescriptive UPI guidance", () => {
    const diag = diagnosePaymentFailure({
      failureCode: "BAD_REQUEST_ERROR",
      failureDescription: "Payment failed due to insufficient balance in your account",
      failureSource: "bank",
      failureStep: "payment_authorization",
      failureReason: "payment_insufficient_funds",
      paymentMethod: "card",
      cardLast4: "4242",
      cardIssuer: "HDFC",
      acquirerErrorCode: "51",
      acquirerRrn: "987654321012",
    });

    expect(diag.faultDomain).toBe("CUSTOMER_BALANCE");
    expect(diag.isoCode).toBe("ISO-8583: 51");
    expect(diag.badgeCss).toBe("soft");
    expect(diag.badgeText).toContain("LOW BALANCE");
    expect(diag.customerTitle).toBe("Temporary Balance Issue");
    expect(diag.customerDescription).toContain("insufficient funds");
    expect(diag.prescriptiveAction).toContain("1-Tap UPI");
    expect(diag.recommendedMethod).toBe("UPI_INTENT");
    expect(diag.rrn).toBe("987654321012");
  });

  it("diagnoses test-mode card ending in 0001 as customer balance issue", () => {
    const diag = diagnosePaymentFailure({
      failureCode: "BAD_REQUEST_ERROR",
      failureDescription: "Payment was declined by the issuing bank",
      failureSource: "bank",
      failureStep: "payment_authorization",
      failureReason: "payment_declined_by_bank",
      paymentMethod: "card",
      cardLast4: "0001",
    });

    expect(diag.faultDomain).toBe("CUSTOMER_BALANCE");
    expect(diag.isoCode).toBe("ISO-8583: 51");
    expect(diag.badgeText).toContain("LOW BALANCE");
  });

  it("diagnoses issuer bank switch outage (ISO-8583 Code 91 / NPCI U30)", () => {
    const diag = diagnosePaymentFailure({
      failureCode: "GATEWAY_TIMEOUT",
      failureDescription: "Issuer switch timed out waiting for core banking system",
      failureSource: "bank",
      failureStep: "payment_authorization",
      failureReason: "issuer_down",
      paymentMethod: "card",
      cardLast4: "1234",
      cardIssuer: "HDFC Bank",
      acquirerErrorCode: "91",
    });

    expect(diag.faultDomain).toBe("ISSUER_OUTAGE");
    expect(diag.isoCode).toContain("ISO-8583: 91");
    expect(diag.badgeCss).toBe("network");
    expect(diag.customerTitle).toContain("HDFC Bank Gateway Timed Out");
    expect(diag.prescriptiveAction).toContain("Do not retry the same HDFC Bank account");
    expect(diag.recommendedMethod).toBe("UPI_INTENT");
  });

  it("diagnoses test-mode card ending in 0002 as issuer switch outage", () => {
    const diag = diagnosePaymentFailure({
      failureCode: "BAD_REQUEST_ERROR",
      failureDescription: "Payment declined",
      paymentMethod: "card",
      cardLast4: "0002",
      cardIssuer: "SBI",
    });

    expect(diag.faultDomain).toBe("ISSUER_OUTAGE");
    expect(diag.customerTitle).toContain("SBI Gateway Timed Out");
  });

  it("diagnoses 3DS authentication / OTP failure without technical jargon", () => {
    const diag = diagnosePaymentFailure({
      failureCode: "BAD_REQUEST_ERROR",
      failureDescription: "OTP entered was incorrect or expired",
      failureSource: "customer",
      failureStep: "payment_authentication",
      failureReason: "invalid_otp",
      paymentMethod: "card",
      cardLast4: "5555",
    });

    expect(diag.faultDomain).toBe("AUTH_FAILED");
    expect(diag.isoCode).toContain("3DS-2.0");
    expect(diag.customerTitle).toBe("Verification Incomplete");
    expect(diag.customerDescription).toContain("one-time password (OTP)");
    expect(diag.prescriptiveAction).toContain("biometric/PIN verification");
    expect(diag.recommendedMethod).toBe("UPI_INTENT");
  });

  it("diagnoses expired or blocked card instrument (ISO-8583 Code 54)", () => {
    const diag = diagnosePaymentFailure({
      failureCode: "CARD_EXPIRED",
      failureDescription: "Card has expired",
      failureSource: "customer",
      failureStep: "payment_authorization",
      failureReason: "payment_card_expired",
      paymentMethod: "card",
      cardLast4: "0003",
      acquirerErrorCode: "54",
    });

    expect(diag.faultDomain).toBe("INSTRUMENT_DEAD");
    expect(diag.isoCode).toContain("ISO-8583: 54");
    expect(diag.badgeCss).toBe("hard");
    expect(diag.customerTitle).toContain("Inactive or Expired");
  });

  it("diagnoses risk-flagged transactions cleanly", () => {
    const diag = diagnosePaymentFailure({
      failureCode: "RISK_FLAGGED",
      failureDescription: "Flagged by velocity risk engine",
      failureSource: "gateway",
      failureStep: "payment_initiation",
      failureReason: "payment_risk_check_failed",
    });

    expect(diag.faultDomain).toBe("RISK_FLAGGED");
    expect(diag.badgeCss).toBe("risk");
    expect(diag.customerTitle).toBe("Security Verification Underway");
  });

  it("falls back gracefully for generic declines with actionable guidance", () => {
    const diag = diagnosePaymentFailure({
      failureCode: "UNKNOWN_ERROR",
      failureDescription: "General bank decline",
    });

    expect(diag.faultDomain).toBe("GENERIC_DECLINE");
    expect(diag.isoCode).toContain("ISO-8583: 05");
    expect(diag.customerTitle).toBe("Payment Could Not Be Completed");
    expect(diag.prescriptiveAction).toContain("Switch to 1-Tap UPI");
  });

  it("API /api/events/:eventId returns deep diagnosis object with ISO code and prescriptive action", async () => {
    const { app, dbClient } = await import("../../app/server.js");
    const eventId = `evt_diag_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const custId = `cust_diag_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const phone = `98${Math.floor(10000000 + Math.random() * 90000000)}`;

    await dbClient.execute({
      sql: `INSERT INTO customer_profiles (id, name, phone, email, created_at_utc) VALUES (?, 'Diag User', ?, 'diag@example.com', datetime('now'))`,
      args: [custId, phone],
    });

    await dbClient.execute({
      sql: `INSERT INTO live_payment_events (id, razorpay_payment_id, razorpay_order_id, customer_profile_id, product_name, amount_paise, status, failure_code, failure_description, failure_source, failure_step, failure_reason, card_last4, acquirer_error_code, acquirer_rrn, created_at_utc)
            VALUES (?, 'pay_diag_1', 'order_diag_1', ?, 'Test Product', 499900, 'failed', 'BAD_REQUEST_ERROR', 'Low balance', 'bank', 'payment_authorization', 'payment_insufficient_funds', '0001', '51', 'rrn_diag_123', datetime('now'))`,
      args: [eventId, custId],
    });

    const server = app.listen(0);
    const addr = server.address() as any;
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/events/${eventId}`);
    const data = await res.json() as any;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(res.status).toBe(200);
    expect(data.diagnosis).toBeDefined();
    expect(data.diagnosis.faultDomain).toBe("CUSTOMER_BALANCE");
    expect(data.diagnosis.isoCode).toBe("ISO-8583: 51");
    expect(data.diagnosis.customerTitle).toBe("Temporary Balance Issue");
    expect(data.acquirerRrn).toBe("rrn_diag_123");
  });
});
