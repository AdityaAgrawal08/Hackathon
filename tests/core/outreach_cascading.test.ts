/**
 * Test Suite for Outreach Multi-Rail Cascading (Phase 2 / Task 2.3)
 *
 * Verifies:
 * 1. Automatic failover within the same channel (MSG91 fails -> Brevo SMS succeeds).
 * 2. Cross-channel cascade (SMS fails or is blocked by DND -> automatically cascades to Email).
 * 3. Preservation of audit trail and status tags.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OutreachRouter } from "../../packages/core/src/messaging/router.js";
import { MSG91SmsProvider } from "../../packages/core/src/messaging/providers/msg91.js";
import { BrevoSmsProvider } from "../../packages/core/src/messaging/providers/brevo_sms.js";
import { BrevoEmailProvider } from "../../packages/core/src/messaging/providers/brevo.js";
import type { OutreachPayload } from "../../packages/core/src/messaging/types.js";

describe("Phase 2 / SMS-03: Multi-Rail Failover & Cascading Router", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const testPayload: OutreachPayload = {
    proposalId: "prop_cascade_01",
    failureClass: "SOFT_RETRYABLE",
    action: "SWITCH_ACCOUNT_OR_RETRY",
    recipient: {
      name: "Ramesh Kumar",
      phone: "+919876500001",
      email: "ramesh@example.com",
    },
    amountPaise: 199900,
    recoveryUrl: "https://arbiter.live/pay/tok_cascade_123",
    language: "EN",
  };

  it("fails over from MSG91 to Brevo SMS when MSG91 returns an API failure", async () => {
    // Mock MSG91 to return FAILED (e.g. out of SMS credits)
    // Mock Brevo SMS to return SUCCESS
    global.fetch = vi.fn().mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("msg91")) {
        return {
          ok: false,
          status: 402,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ type: "error", message: "Insufficient balance in MSG91 account" }),
        };
      }
      if (urlStr.includes("brevo.com/v3/transactionalSMS")) {
        return {
          ok: true,
          status: 201,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ reference: "brevo_ref_123", messageId: 991122 }),
        };
      }
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({}) };
    });

    const router = new OutreachRouter();
    const msg91 = new MSG91SmsProvider({ authKey: "key_msg91", flowId: "flow_123" });
    const brevoSms = new BrevoSmsProvider({ apiKey: "key_brevo_sms" });

    router.registerProvider(msg91);
    router.registerProvider(brevoSms);

    const result = await router.dispatch("SMS", testPayload);

    // Verify it failed over and succeeded via Brevo SMS
    expect(result.providerName).toBe("brevo_sms");
    expect(result.status).toBe("SENT");
    expect(result.externalMessageId).toBe("991122");
  });

  it("cascades from SMS to Email via dispatchWithCascade when all SMS rails fail", async () => {
    // Both MSG91 and Brevo SMS fail
    global.fetch = vi.fn().mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("msg91") || urlStr.includes("transactionalSMS")) {
        return {
          ok: false,
          status: 500,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ error: "Service unavailable" }),
        };
      }
      if (urlStr.includes("smtp/email")) {
        return {
          ok: true,
          status: 201,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ messageId: "<email_brevo_123@smtp.brevo.com>" }),
        };
      }
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({}) };
    });

    const router = new OutreachRouter();
    const msg91 = new MSG91SmsProvider({ authKey: "key_msg91", flowId: "flow_123" });
    const brevoSms = new BrevoSmsProvider({ apiKey: "key_brevo_sms" });
    const brevoEmail = new BrevoEmailProvider({ apiKey: "key_brevo_email" });

    router.registerProvider(brevoEmail);
    router.registerProvider(msg91);
    router.registerProvider(brevoSms);

    const result = await router.dispatchWithCascade("SMS", testPayload);

    expect(result.providerName).toBe("brevo");
    expect(result.channel).toBe("EMAIL");
    expect(result.cascadedFrom).toBe("SMS");
    expect(result.status).toBe("SENT");
  });

  it("automatically cascades to Email when phone is on NCPR DND registry", async () => {
    const router = new OutreachRouter();
    router.addDndNumber("+919876500001"); // Add customer to DND

    const brevoEmail = new BrevoEmailProvider(); // simulated
    const msg91 = new MSG91SmsProvider(); // simulated

    router.registerProvider(brevoEmail);
    router.registerProvider(msg91);

    const result = await router.dispatchWithCascade("SMS", testPayload);

    expect(result.channel).toBe("EMAIL");
    expect(result.cascadedFrom).toBe("SMS");
    expect(result.status).toBe("SENT");
  });
});
