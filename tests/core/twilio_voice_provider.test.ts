import { describe, it, expect } from "vitest";
import {
  TwilioVoiceProvider,
  generateTwilioIVRTwiML,
  generateTwilioHandoffTwiML,
} from "../../packages/core/src/messaging/providers/twilio_voice.js";
import type { OutreachPayload } from "../../packages/core/src/messaging/types.js";

describe("Task 2.4: Twilio Voice IVR Provider & TwiML Generator", () => {
  const payload: OutreachPayload = {
    tenantId: "demo",
    proposalId: "prop_voice_001",
    idempotencyKey: "idem_voice_123",
    recipient: {
      customerId: "cust_123",
      name: "Rahul Sharma",
      phone: "+91 98765 43210",
      language: "HI",
    },
    amountPaise: 199900,
    failureClass: "SOFT_RETRYABLE",
    instrumentDescription: "HDFC Bank ending in 4120",
    recoveryUrl: "https://pay.arbiter.in/r/tok_voice_1",
  };

  it("generates valid TwiML with Polly.Aditi Hindi voice and <Gather> for Press 1", () => {
    const twiml = generateTwilioIVRTwiML(payload, "https://pay.arbiter.in/api/webhooks/twilio/gather");

    expect(twiml).toContain("<Response>");
    expect(twiml).toContain("<Gather numDigits=\"1\"");
    expect(twiml).toContain("Polly.Aditi");
    expect(twiml).toContain("language=\"hi-IN\"");
    expect(twiml).toContain("Rahul Sharma");
    expect(twiml).toContain("₹1,999.00");
    expect(twiml).toContain("<Hangup/>");
  });

  it("generates TwiML for Indian English when recipient language is EN", () => {
    const enPayload: OutreachPayload = {
      ...payload,
      recipient: { ...payload.recipient, language: "EN" },
    };
    const twiml = generateTwilioIVRTwiML(enPayload, "https://pay.arbiter.in/api/webhooks/twilio/gather");

    expect(twiml).toContain("Polly.Raveena");
    expect(twiml).toContain("language=\"en-IN\"");
  });

  it("generates handoff TwiML confirming WhatsApp/SMS dispatch after Press 1", () => {
    const handoff = generateTwilioHandoffTwiML(true);
    expect(handoff).toContain("WhatsApp aur SMS par secure payment link");
  });

  it("dispatches voice call in simulated mode with correct cost calculation", async () => {
    const provider = new TwilioVoiceProvider();
    const result = await provider.send(payload);

    expect(result.providerName).toBe("twilio_voice");
    expect(result.channel).toBe("VOICE");
    expect(result.status).toBe("QUEUED");
    expect(result.costPaise).toBe(800); // ₹8.00 (COST_VOICE_PAISE default)
    expect(result.externalMessageId).toContain("twilio_sim_");
  });
});
