import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { razorpayProvider } from "../../packages/core/src/executor/providers/razorpay.js";
import type { ProviderContext } from "../../packages/core/src/executor/providers/types.js";

describe("Razorpay Test-Mode Payment Link Provider (RZP-02)", () => {
  const originalFetch = globalThis.fetch;
  const originalKeyId = process.env.RZP_TEST_KEY_ID;
  const originalSecret = process.env.RZP_TEST_KEY_SECRET;

  beforeEach(() => {
    process.env.RZP_TEST_KEY_ID = "rzp_test_mockKeyId123";
    process.env.RZP_TEST_KEY_SECRET = "mockSecretKey456";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.RZP_TEST_KEY_ID = originalKeyId;
    process.env.RZP_TEST_KEY_SECRET = originalSecret;
    vi.restoreAllMocks();
  });

  it("calls Razorpay API and returns paymentLinkUrl on successful creation", async () => {
    const mockPlinkId = "plink_test_abc123";
    const mockShortUrl = "https://rzp.io/i/arbiter123";

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: mockPlinkId,
        short_url: mockShortUrl,
        status: "created",
      }),
    });

    const ctx: ProviderContext = {
      proposalId: "prop_unit_test_001",
      actionId: "ALTERNATE_UPI_LINK",
      failureClass: "HARD_METHOD_DEAD",
      amountPaise: 499900,
      evPaise: 400000,
      tenantId: "tenant_default",
      rzpRequestRef: "rzp_ref_12345",
      idempotencyKey: "idem_unit_test_key",
      nowMs: Date.now(),
      customer: {
        name: "Vikram Sharma",
        phone: "+919876543210",
        email: "vikram@example.com",
      },
    };

    const result = await razorpayProvider.execute(ctx);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(result.rzpResponseRef).toBe(mockPlinkId);
    expect(result.paymentLinkUrl).toBe(mockShortUrl);
    expect(result.outcome).toBe("SUCCEEDED");
  });

  it("falls back to dry-run gracefully if API call returns an error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { description: "Invalid amount" } }),
    });

    const ctx: ProviderContext = {
      proposalId: "prop_unit_test_002",
      actionId: "ALTERNATE_UPI_LINK",
      failureClass: "HARD_METHOD_DEAD",
      amountPaise: 499900,
      evPaise: 400000,
      tenantId: "tenant_default",
      rzpRequestRef: "rzp_ref_12345",
      idempotencyKey: "idem_unit_test_key",
      nowMs: Date.now(),
    };

    const result = await razorpayProvider.execute(ctx);
    expect(result).toBeDefined();
    expect(result.outcome).toBe("SUCCEEDED"); // Viable action in catalog
    expect(result.dryRunPayload).toBeDefined();
  });

  it("returns FAILED for known-dead actions based on catalog multiplier", async () => {
    // RETRY_NOW on HARD_METHOD_DEAD has multiplier 0 in catalog
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network connection reset"));

    const ctx: ProviderContext = {
      proposalId: "prop_unit_test_003",
      actionId: "RETRY_NOW",
      failureClass: "HARD_METHOD_DEAD",
      amountPaise: 499900,
      evPaise: 0,
      tenantId: "tenant_default",
      rzpRequestRef: "rzp_ref_12345",
      idempotencyKey: "idem_unit_test_key",
      nowMs: Date.now(),
    };

    const result = await razorpayProvider.execute(ctx);
    expect(result.outcome).toBe("FAILED");
  });
});
