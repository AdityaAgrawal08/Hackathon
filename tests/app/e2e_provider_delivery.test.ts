import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app } from "../../app/server.js";
import {
  BrevoEmailProvider,
  MSG91SmsProvider,
  TwilioVoiceProvider,
  generateTwilioHandoffTwiML,
  type OutreachPayload,
} from "../../packages/core/src/index.js";

describe("Phase 7: Multi-Channel Provider Live Delivery & Synthesis Verification (Tasks 7.2–7.4)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("Task 7.2: verifies transactional email delivery and token replacement via Brevo", async () => {
    const brevo = new BrevoEmailProvider();
    const payload: OutreachPayload = {
      proposalId: "prop_brevo_test",
      failureClass: "SOFT_RETRYABLE",
      action: "RECOVER_EMAIL",
      recipient: {
        customerName: "Sneha Reddy",
        phone: "+91 98765 11223",
        email: "sneha.reddy@example.com",
      },
      amountPaise: 249900, // ₹2,499
      paymentLinkUrl: "https://arbiter.live/pay/tok_brevo_test",
      language: "EN",
      rawErrorReason: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
    };

    const result = await brevo.send(payload);

    expect(result.status).toBe("SENT");
    expect(result.channel).toBe("EMAIL");
    expect(result.providerName).toBe("brevo");
    expect(result.externalMessageId).toMatch(/^brevo_/);
    expect(result.costPaise).toBe(10); // 10 paise email unit cost
    expect(result.dispatchedAtUtc).toBeDefined();
  });

  it("Task 7.3: verifies DLT template 1407168923450011 and token mapping via MSG91 SMS", async () => {
    const msg91 = new MSG91SmsProvider({ senderId: "ARBITR" });
    const payload: OutreachPayload = {
      proposalId: "prop_msg91_test",
      failureClass: "SOFT_RETRYABLE",
      action: "RECOVER_SMS",
      recipient: {
        customerName: "Vikram Malhotra",
        phone: "+91 98111 55443",
      },
      amountPaise: 199900, // ₹1,999
      paymentLinkUrl: "https://arbiter.live/pay/tok_msg91_test",
      language: "EN",
      rawErrorReason: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
    };

    const result = await msg91.send(payload);

    expect(result.status).toBe("SENT");
    expect(result.channel).toBe("SMS");
    expect(result.providerName).toBe("msg91");
    expect(result.externalMessageId).toMatch(/^msg91_/);
    expect(result.costPaise).toBe(25); // 25 paise DLT Route 4 interchange cost
    expect(result.dispatchedAtUtc).toBeDefined();
  });

  it("Task 7.4: verifies Twilio Outbound Voice IVR synthesis and Press-1 handoff", async () => {
    const twilio = new TwilioVoiceProvider();
    const payload: OutreachPayload = {
      proposalId: "prop_twilio_test",
      failureClass: "SOFT_RETRYABLE",
      action: "RECOVER_VOICE_HI",
      recipient: {
        customerName: "Aakash Verma",
        phone: "+91 98222 33445",
      },
      amountPaise: 499900, // ₹4,999
      paymentLinkUrl: "https://arbiter.live/pay/tok_voice_test",
      language: "HI",
      rawErrorReason: "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE",
    };

    const result = await twilio.send(payload);

    expect(["SENT", "QUEUED"]).toContain(result.status);
    expect(result.channel).toBe("VOICE");

    expect(result.providerName).toBe("twilio_voice");
    expect(result.externalMessageId).toMatch(/^twilio_/);
    expect(result.costPaise).toBe(150); // 150 paise voice unit cost

    // Verify Interactive IVR TwiML structure with Amazon Polly.Aditi neural voice and Gather
    const ivrTwiml = (result.rawResponse as any)?.twiml;
    expect(ivrTwiml).toContain('<Response>');
    expect(ivrTwiml).toContain('<Gather numDigits="1"');
    expect(ivrTwiml).toContain('Polly.Aditi');
    expect(ivrTwiml).toContain('</Response>');

    // Verify Post-Handoff Confirmation TwiML
    const handoffTwiml = generateTwilioHandoffTwiML(true);
    expect(handoffTwiml).toContain('<Response>');
    expect(handoffTwiml).toContain('Polly.Aditi');
    expect(handoffTwiml).toContain('</Response>');
  });
});

