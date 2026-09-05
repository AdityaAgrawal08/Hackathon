/**
 * Specialized Test Suite: Razorpay Native Payment Links API & Fallbacks (FIX-038)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createRazorpayNativePaymentLink,
  razorpayProvider,
} from "../../packages/core/src/executor/providers/razorpay.js";

describe("FIX-038: Razorpay Native Payment Links API (POST /v1/payment_links)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null gracefully when Razorpay credentials are not configured", async () => {
    delete process.env.RZP_TEST_KEY_ID;
    delete process.env.RZP_KEY_ID;
    delete process.env.RZP_TEST_KEY_SECRET;
    delete process.env.RZP_KEY_SECRET;
    delete process.env.REAL_EXECUTION_MODE;

    const result = await createRazorpayNativePaymentLink({
      amountPaise: 199900,
      description: "Recovery Payment Link",
      customer: { name: "Test User", phone: "+919876543210" },
    });

    expect(result).toBeNull();
  });

  it("calls https://api.razorpay.com/v1/payment_links with valid Basic Auth and payload when keys are present", async () => {
    process.env.RZP_TEST_KEY_ID = "rzp_test_mock_key_id";
    process.env.RZP_TEST_KEY_SECRET = "mock_secret_value_123";

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "plink_mock_7788",
        short_url: "https://rzp.io/i/plink_mock_7788",
        amount: 249900,
        currency: "INR",
        status: "created",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createRazorpayNativePaymentLink({
      amountPaise: 249900,
      description: "Cart Abandonment Salvage",
      customer: {
        name: "Rohan Verma",
        phone: "+919811122233",
        email: "rohan@example.com",
      },
      notes: { recovery_tier: "1_TAP_UPI" },
      idempotencyKey: "idem_plink_001",
    });

    expect(result).not.toBeNull();
    expect(result?.id).toBe("plink_mock_7788");
    expect(result?.short_url).toBe("https://rzp.io/i/plink_mock_7788");

    // Inspect fetch call arguments
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, reqOptions] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.razorpay.com/v1/payment_links");
    expect(reqOptions.method).toBe("POST");

    const authHeader = reqOptions.headers["Authorization"];
    expect(authHeader).toBeDefined();
    expect(authHeader.startsWith("Basic ")).toBe(true);

    const expectedCredentials = Buffer.from("rzp_test_mock_key_id:mock_secret_value_123").toString("base64");
    expect(authHeader).toBe(`Basic ${expectedCredentials}`);
    expect(reqOptions.headers["X-Razorpay-Idempotency-Key"]).toBe("idem_plink_001");

    const body = JSON.parse(reqOptions.body);
    expect(body.amount).toBe(249900);
    expect(body.currency).toBe("INR");
    expect(body.description).toBe("Cart Abandonment Salvage");
    expect(body.customer.name).toBe("Rohan Verma");
    expect(body.customer.contact).toBe("+919811122233");
    expect(body.customer.email).toBe("rohan@example.com");
    expect(body.notes.recovery_tier).toBe("1_TAP_UPI");
  });

  it("handles upstream API failure (400 / 500) gracefully without throwing exceptions", async () => {
    process.env.RZP_TEST_KEY_ID = "rzp_test_mock_key_id";
    process.env.RZP_TEST_KEY_SECRET = "mock_secret_value_123";

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { code: "BAD_REQUEST_ERROR", description: "Invalid phone number" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createRazorpayNativePaymentLink({
      amountPaise: 50000,
      description: "Invalid Phone Test",
      customer: { phone: "invalid-phone" },
    });

    expect(result).toBeNull();
  });

  it("razorpayProvider executes dry-run builds correctly for RETRY_NOW and ALTERNATE_UPI_LINK", async () => {
    delete process.env.REAL_EXECUTION_MODE;

    const resRetryNow = await razorpayProvider.execute({
      actionId: "RETRY_NOW",
      failureClass: "SOFT_RETRYABLE",
      tenantId: "t_demo",
      proposalId: "prop_01",
      amountPaise: 150000,
      idempotencyKey: "idem_01",
      rzpRequestRef: "ref_01",
      customer: { name: "Aarav", phone: "+919988776655" },
    });

    expect(resRetryNow.outcome).toBe("SUCCEEDED");
    expect(resRetryNow.dryRunPayload).toBeDefined();
    expect(resRetryNow.dryRunPayload.amount).toBe(150000);

    const resAltUpi = await razorpayProvider.execute({
      actionId: "ALTERNATE_UPI_LINK",
      failureClass: "SOFT_RETRYABLE",
      tenantId: "t_demo",
      proposalId: "prop_02",
      amountPaise: 299900,
      idempotencyKey: "idem_02",
      rzpRequestRef: "ref_02",
      customer: { name: "Ananya", phone: "+919988776644" },
    });

    expect(resAltUpi.outcome).toBe("SUCCEEDED");
    expect(resAltUpi.dryRunPayload).toBeDefined();
    expect(resAltUpi.dryRunPayload.method).toBe("upi");
  });
});
