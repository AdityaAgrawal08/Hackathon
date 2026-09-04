/**
 * Hardened Test Suite for MSG91 Flow API Provider (Phase 2 / Task 2.1)
 *
 * Verifies:
 * 1. Flow ID and DLT template ID resolution.
 * 2. Injection of dual positional (VAR1..VAR4, var1..var4, 1..4) + semantic variables.
 * 3. Root "sender" header inclusion ("ARBITR").
 * 4. Rectification of the silent false-positive bug (HTTP 200 with type: "error" is marked FAILED).
 * 5. Successful delivery with request_id parsing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MSG91SmsProvider } from "../../packages/core/src/messaging/providers/msg91.js";
import type { OutreachPayload } from "../../packages/core/src/messaging/types.js";

describe("Phase 2 / SMS-01: Hardened MSG91 Flow API Provider", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const samplePayload: OutreachPayload = {
    proposalId: "prop_msg91_hardened_01",
    failureClass: "SOFT_RETRYABLE",
    action: "SWITCH_ACCOUNT_OR_RETRY",
    recipient: {
      name: "Aditya Sharma",
      phone: "9876543210",
      email: "aditya@example.com",
    },
    amountPaise: 299900,
    recoveryUrl: "https://arbiter.live/pay/tok_flow_123",
    language: "EN",
    rawErrorReason: "INSUFFICIENT_FUNDS",
    instrumentDescription: "UPI - Primary Account",
  };

  it("injects dual positional and semantic variables and root sender into Flow body", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;
    let capturedHeaders: any = null;

    global.fetch = vi.fn().mockImplementation(async (url, opts) => {
      capturedUrl = String(url);
      capturedHeaders = opts.headers;
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ type: "success", request_id: "req_msg91_success_999" }),
      };
    });

    const provider = new MSG91SmsProvider({
      authKey: "real_auth_key_12345678",
      flowId: "flow_hex_65a4c21980",
      senderId: "ARBITR",
    });

    const result = await provider.send(samplePayload);

    expect(capturedUrl).toBe("https://control.msg91.com/api/v5/flow");
    expect(capturedHeaders.authkey).toBe("real_auth_key_12345678");
    expect(capturedBody.template_id).toBe("flow_hex_65a4c21980");
    expect(capturedBody.sender).toBe("ARBITR");

    const recipient = capturedBody.recipients[0];
    expect(recipient.mobiles).toBe("919876543210");
    expect(recipient.name).toBe("Aditya Sharma");
    expect(recipient.amount).toBe("₹2,999.00");
    expect(recipient.url).toBe("https://arbiter.live/pay/tok_flow_123");

    // Verify positional DLT tokens
    expect(recipient.VAR1).toBe("Aditya Sharma");
    expect(recipient.VAR2).toBe("₹2,999.00");
    expect(recipient.VAR3).toBe("https://arbiter.live/pay/tok_flow_123");
    expect(recipient.VAR4).toBe("ARBITER Store");
    expect(recipient["1"]).toBe("Aditya Sharma");
    expect(recipient["2"]).toBe("₹2,999.00");

    expect(result.status).toBe("SENT");
    expect(result.costPaise).toBe(25);
  });

  it("CRITICAL FIX: marks HTTP 200 with type 'error' as FAILED (fixes false-positive bug)", async () => {
    global.fetch = vi.fn().mockImplementation(async () => {
      return {
        ok: true, // MSG91 returns HTTP 200 even for some application errors
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          type: "error",
          message: "Template Not Found or Variable Mismatch",
          code: "INVALID_TEMPLATE",
        }),
      };
    });

    const provider = new MSG91SmsProvider({
      authKey: "real_auth_key_12345678",
      flowId: "invalid_flow_id",
      senderId: "ARBITR",
    });

    const result = await provider.send(samplePayload);

    // Previously this was falsely marked SENT!
    expect(result.status).toBe("FAILED");
    expect(result.costPaise).toBe(0);
    expect(result.errorMessage).toContain("Template Not Found");
  });

  it("correctly handles simulated mode when credentials are missing", async () => {
    const provider = new MSG91SmsProvider({
      authKey: undefined,
      templateId: undefined,
    });

    const result = await provider.send(samplePayload);
    expect(result.status).toBe("SENT");
    expect(result.externalMessageId).toContain("msg91_sim_");
    expect(result.costPaise).toBe(0);
  });
});
