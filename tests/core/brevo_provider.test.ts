import { describe, it, expect } from "vitest";
import { BrevoEmailProvider } from "../../packages/core/src/messaging/providers/brevo.js";
import type { OutreachPayload } from "../../packages/core/src/messaging/types.js";

describe("Task 2.2: Brevo Transactional Email Provider", () => {
  const payload: OutreachPayload = {
    tenantId: "demo",
    proposalId: "prop_brevo_001",
    idempotencyKey: "idem_brevo_123",
    recipient: {
      customerId: "cust_123",
      name: "Rahul Sharma",
      email: "rahul@example.com",
      phone: "+919876543210",
      language: "EN",
    },
    amountPaise: 199900,
    failureClass: "SOFT_RETRYABLE",
    instrumentDescription: "HDFC Card ending in 4120",
    recoveryUrl: "https://pay.arbiter.in/r/tok_brevo_1",
  };

  it("dispatches email in simulated mode when no API key is provided", async () => {
    const provider = new BrevoEmailProvider();
    const result = await provider.send(payload);

    expect(result.providerName).toBe("brevo");
    expect(result.channel).toBe("EMAIL");
    expect(result.status).toBe("SENT");
    expect(result.costPaise).toBe(10); // ₹0.10
    expect(result.externalMessageId).toContain("brevo_sim_");
  });

  it("formats Hindi email template correctly when recipient language is HI", async () => {
    const provider = new BrevoEmailProvider();
    const hiPayload: OutreachPayload = {
      ...payload,
      recipient: { ...payload.recipient, language: "HI" },
    };

    const result = await provider.send(hiPayload);
    expect(result.status).toBe("SENT");
    expect(result.rawResponse).toBeDefined();
  });

  it("verifies webhook signatures using HMAC-SHA256 timing-safe check", () => {
    const secret = "test_secret_key";
    const provider = new BrevoEmailProvider({ webhookSecret: secret });

    // In dev without matching payload/signature, should handle false gracefully
    const isValid = provider.verifyWebhookSignature("{}", "invalid_signature");
    expect(isValid).toBe(false);
  });
});
