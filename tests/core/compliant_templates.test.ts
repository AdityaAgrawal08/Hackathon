import { describe, it, expect } from "vitest";
import {
  renderComplianceMessage,
  type MessageTokenContext,
} from "../../packages/core/src/messaging/templates.js";

describe("Pre-Audited Compliance Messaging Templates (Task 1.4)", () => {
  const context: MessageTokenContext = {
    customerName: "Rahul Sharma",
    amountPaise: 199900,
    merchantName: "SaaSify Pro",
    instrumentDescription: "HDFC Bank ending in 4120",
    recoveryUrl: "https://pay.arbiter.in/r/tok_123456",
  };

  it("renders compliant English WhatsApp template for INSUFFICIENT_FUNDS (SOFT_RETRYABLE)", () => {
    const msg = renderComplianceMessage("SOFT_RETRYABLE", "WHATSAPP", "EN", context);
    expect(msg).not.toBeNull();
    expect(msg?.templateId).toBe("arbiter_rec_whatsapp_insufficient_v1");
    expect(msg?.dltRegistered).toBe(true);
    expect(msg?.content).toContain("Rahul Sharma");
    expect(msg?.content).toContain("₹1,999.00");
    expect(msg?.content).toContain("HDFC Bank ending in 4120");
    expect(msg?.content).toContain("https://pay.arbiter.in/r/tok_123456");
  });

  it("renders compliant Hinglish WhatsApp template for INSUFFICIENT_FUNDS", () => {
    const msg = renderComplianceMessage("SOFT_RETRYABLE", "WHATSAPP", "HI", context);
    expect(msg).not.toBeNull();
    expect(msg?.content).toContain("Namaste Rahul Sharma");
    expect(msg?.content).toContain("balance kam hone ki wajah se");
    expect(msg?.content).toContain("₹1,999.00");
  });

  it("renders compliant Hinglish Voice IVR script for CARD_EXPIRED (HARD_METHOD_DEAD)", () => {
    const msg = renderComplianceMessage("HARD_METHOD_DEAD", "VOICE_IVR", "HI", context);
    expect(msg).not.toBeNull();
    expect(msg?.templateId).toBe("ivr_script_expired_hi_v1");
    expect(msg?.content).toContain("Namaste Rahul Sharma");
    expect(msg?.content).toContain("card expire ho gaya hai");
    expect(msg?.content).toContain("1 dabayein");
  });

  it("strictly returns null (prohibits automated outreach) for RISK_FLAGGED failures", () => {
    const msgWhatsApp = renderComplianceMessage("RISK_FLAGGED", "WHATSAPP", "EN", context);
    expect(msgWhatsApp).toBeNull();

    const msgVoice = renderComplianceMessage("RISK_FLAGGED", "VOICE_IVR", "HI", context);
    expect(msgVoice).toBeNull();
  });
});
