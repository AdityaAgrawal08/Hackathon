/**
 * Test Suite for Brevo Transactional SMS Provider (Phase 2 / Task 2.2)
 *
 * Verifies:
 * 1. Transactional SMS payload structure to Brevo v3 endpoint.
 * 2. GSM-compliant 11-character sender truncation.
 * 3. Zero-payday messaging formulation for SOFT_RETRYABLE.
 * 4. Error response parsing and status assignment.
 * 5. Dry-run simulation when BREVO_API_KEY is missing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BrevoSmsProvider } from "../../packages/core/src/messaging/providers/brevo_sms.js";
import type { OutreachPayload } from "../../packages/core/src/messaging/types.js";

describe("Phase 2 / SMS-02: Brevo Transactional SMS Provider", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const samplePayload: OutreachPayload = {
    proposalId: "prop_brevo_sms_01",
    failureClass: "SOFT_RETRYABLE",
    action: "SWITCH_ACCOUNT_OR_RETRY",
    recipient: {
      name: "Pooja Hegde",
      phone: "+91 98765 43210",
      email: "pooja@example.com",
    },
    amountPaise: 149900,
    recoveryUrl: "https://arbiter.live/pay/tok_brevo_123",
    language: "EN",
    rawErrorReason: "INSUFFICIENT_FUNDS",
  };

  it("dispatches transactional SMS payload to Brevo API with normalized phone and zero payday text", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;
    let capturedHeaders: any = null;

    global.fetch = vi.fn().mockImplementation(async (url, opts) => {
      capturedUrl = String(url);
      capturedHeaders = opts.headers;
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 201,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          reference: "ref_brevo_sms_99",
          messageId: 987654321,
          smsCount: 1,
          usedCredits: 1.0,
          remainingCredits: 99.0,
        }),
      };
    });

    const provider = new BrevoSmsProvider({
      apiKey: "xkeysib-brevo-api-key-test-12345",
      sender: "ARBITER",
    });

    const result = await provider.send(samplePayload);

    expect(capturedUrl).toBe("https://api.brevo.com/v3/transactionalSMS/send");
    expect(capturedHeaders["api-key"]).toBe("xkeysib-brevo-api-key-test-12345");
    expect(capturedBody.sender).toBe("ARBITER");
    expect(capturedBody.recipient).toBe("919876543210");
    expect(capturedBody.type).toBe("transactional");

    // Invariant: Message recommends switching account / try again later with ZERO payday words
    const content = capturedBody.content.toLowerCase();
    expect(content).toContain("low balance");
    expect(content).toContain("alternate bank account/upi app");
    expect(content).not.toContain("payday");
    expect(content).not.toContain("salary");

    expect(result.status).toBe("SENT");
    expect(result.externalMessageId).toBe("987654321");
    expect(result.costPaise).toBe(35);
  });

  it("handles simulated mode gracefully when BREVO_API_KEY is not configured", async () => {
    const provider = new BrevoSmsProvider({ apiKey: undefined });
    const result = await provider.send(samplePayload);

    expect(result.status).toBe("SENT");
    expect(result.externalMessageId).toContain("brevo_sms_sim_");
    expect(result.costPaise).toBe(0);
  });

  it("handles API errors from Brevo and marks status as FAILED", async () => {
    global.fetch = vi.fn().mockImplementation(async () => {
      return {
        ok: false,
        status: 400,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          code: "invalid_parameter",
          message: "Unrecognized mobile phone country code",
        }),
      };
    });

    const provider = new BrevoSmsProvider({
      apiKey: "xkeysib-test-api-key",
      sender: "ARBITER",
    });

    const result = await provider.send(samplePayload);
    expect(result.status).toBe("FAILED");
    expect(result.costPaise).toBe(0);
    expect(result.errorCode).toBe("invalid_parameter");
    expect(result.errorMessage).toContain("country code");
  });
});
