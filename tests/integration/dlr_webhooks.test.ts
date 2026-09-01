/**
 * B-011: DLR (Delivery Receipt) webhook integration tests.
 * Tests for Brevo/MSG91/Twilio/Gupshup webhook handling with valid/invalid signatures.
 *
 * NOTE: Providers strip secrets in test mode (NODE_ENV=test), so we test
 * the verification logic by checking the method behavior with/without secrets.
 */
import { describe, it, expect } from "vitest";
import { BrevoEmailProvider } from "../../packages/core/src/messaging/providers/brevo.js";
import { MSG91SmsProvider } from "../../packages/core/src/messaging/providers/msg91.js";
import { TwilioVoiceProvider } from "../../packages/core/src/messaging/providers/twilio_voice.js";
import { GupshupWhatsAppProvider } from "../../packages/core/src/messaging/providers/gupshup.js";
import { MSG91EmailProvider } from "../../packages/core/src/messaging/providers/msg91_email.js";
import { createHmac } from "node:crypto";

describe("B-011: DLR webhook integration", () => {
  describe("Brevo webhook verification", () => {
    it("fail-open when no API key configured (dev mode)", () => {
      const provider = new BrevoEmailProvider();
      // Brevo is fail-open in dev/dry-run (existing behavior)
      const result = provider.verifyWebhookSignature("body", "sig123");
      expect(result).toBe(true);
    });

    it("verifies valid HMAC-SHA256 signature when secret is set", () => {
      const secret = "brevo_webhook_secret_123";
      // Create provider with secret injected directly (bypassing env stripping)
      const provider = new BrevoEmailProvider();
      (provider as any).config.webhookSecret = secret;
      const body = "test webhook body";
      const expectedSig = createHmac("sha256", secret).update(body).digest("hex");
      expect(provider.verifyWebhookSignature(body, expectedSig)).toBe(true);
    });

    it("rejects invalid signature when secret is set", () => {
      const provider = new BrevoEmailProvider();
      (provider as any).config.webhookSecret = "secret";
      expect(provider.verifyWebhookSignature("body", "invalid_sig")).toBe(false);
    });
  });

  describe("MSG91 SMS webhook verification", () => {
    it("rejects when no auth key configured", () => {
      const provider = new MSG91SmsProvider();
      const result = provider.verifyWebhookSignature("body", "sig");
      expect(result).toBe(false);
    });

    it("verifies valid HMAC-SHA256 signature when key is set", () => {
      const authKey = "msg91_auth_key_123";
      const provider = new MSG91SmsProvider();
      (provider as any).config.authKey = authKey;
      const body = "test webhook body";
      const expectedSig = createHmac("sha256", authKey).update(body).digest("hex");
      expect(provider.verifyWebhookSignature(body, expectedSig)).toBe(true);
    });

    it("rejects invalid signature when key is set", () => {
      const provider = new MSG91SmsProvider();
      (provider as any).config.authKey = "key";
      expect(provider.verifyWebhookSignature("body", "wrong")).toBe(false);
    });
  });

  describe("MSG91 Email webhook verification", () => {
    it("rejects when no auth key configured", () => {
      const provider = new MSG91EmailProvider();
      const result = provider.verifyWebhookSignature("body", "sig");
      expect(result).toBe(false);
    });

    it("verifies valid HMAC-SHA256 signature when key is set", () => {
      const authKey = "msg91_email_key_123";
      const provider = new MSG91EmailProvider();
      (provider as any).config.authKey = authKey;
      const body = "test webhook body";
      const expectedSig = createHmac("sha256", authKey).update(body).digest("hex");
      expect(provider.verifyWebhookSignature(body, expectedSig)).toBe(true);
    });
  });

  describe("Twilio Voice webhook verification", () => {
    it("rejects when no auth token configured", () => {
      const provider = new TwilioVoiceProvider();
      const result = provider.verifyWebhookSignature("body", "sig");
      expect(result).toBe(false);
    });

    it("verifies valid HMAC-SHA1 signature when token is set", () => {
      const authToken = "twilio_auth_token_123";
      const provider = new TwilioVoiceProvider();
      (provider as any).config.authToken = authToken;
      const body = "test webhook body";
      const expectedSig = createHmac("sha1", authToken).update(body).digest("base64");
      expect(provider.verifyWebhookSignature(body, expectedSig)).toBe(true);
    });

    it("rejects invalid signature when token is set", () => {
      const provider = new TwilioVoiceProvider();
      (provider as any).config.authToken = "token";
      expect(provider.verifyWebhookSignature("body", "wrong")).toBe(false);
    });
  });

  describe("Gupshup WhatsApp webhook verification", () => {
    it("rejects when no webhook secret configured", () => {
      const provider = new GupshupWhatsAppProvider();
      const result = provider.verifyWebhookSignature("body", "sig");
      expect(result).toBe(false);
    });

    it("verifies valid HMAC-SHA256 signature when secret is set", () => {
      const secret = "gupshup_webhook_secret_123";
      const provider = new GupshupWhatsAppProvider();
      (provider as any).config.webhookSecret = secret;
      const body = "test webhook body";
      const expectedSig = createHmac("sha256", secret).update(body).digest("hex");
      expect(provider.verifyWebhookSignature(body, expectedSig)).toBe(true);
    });

    it("rejects invalid signature when secret is set", () => {
      const provider = new GupshupWhatsAppProvider();
      (provider as any).config.webhookSecret = "secret";
      expect(provider.verifyWebhookSignature("body", "bad")).toBe(false);
    });
  });

  describe("Buffer input handling", () => {
    it("handles Buffer input for Twilio verification", () => {
      const authToken = "twilio_token";
      const provider = new TwilioVoiceProvider();
      (provider as any).config.authToken = authToken;
      const body = Buffer.from("test body");
      const expectedSig = createHmac("sha1", authToken).update(body).digest("base64");
      expect(provider.verifyWebhookSignature(body, expectedSig)).toBe(true);
    });

    it("handles Buffer input for Brevo verification", () => {
      const secret = "brevo_secret";
      const provider = new BrevoEmailProvider();
      (provider as any).config.webhookSecret = secret;
      const body = Buffer.from("test body");
      const expectedSig = createHmac("sha256", secret).update(body).digest("hex");
      expect(provider.verifyWebhookSignature(body, expectedSig)).toBe(true);
    });
  });
});
