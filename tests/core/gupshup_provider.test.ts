import { describe, it, expect } from "vitest";
import { GupshupWhatsAppProvider } from "../../packages/core/src/messaging/providers/gupshup.js";
import type { OutreachPayload } from "../../packages/core/src/messaging/types.js";

describe("Task 2.5 & 2.6: Gupshup WhatsApp Provider & Local Token Isolation", () => {
  const payload: OutreachPayload = {
    tenantId: "demo",
    proposalId: "prop_wa_001",
    idempotencyKey: "idem_wa_123",
    recipient: {
      customerId: "cust_123",
      name: "Priya Patel",
      phone: "+91 98111 22334",
      language: "EN",
    },
    amountPaise: 499900,
    failureClass: "HARD_METHOD_DEAD",
    instrumentDescription: "Visa ending in 8831",
    recoveryUrl: "https://pay.arbiter.in/r/tok_wa_1",
  };

  it("builds Meta HSM template payload with strictly local token parameters", async () => {
    const provider = new GupshupWhatsAppProvider();
    const result = await provider.send(payload);

    expect(result.providerName).toBe("gupshup_whatsapp");
    expect(result.channel).toBe("WHATSAPP");
    expect(result.status).toBe("SENT");
    expect(result.costPaise).toBe(120); // ₹1.20 (COST_WHATSAPP_PAISE default)

    const raw = result.rawResponse as {
      params: string[];
      destination: string;
      preview: string;
    };
    expect(raw.destination).toBe("919811122334");
    expect(raw.params[0]).toBe("Priya Patel");
    expect(raw.params[1]).toBe("₹4,999.00");
    expect(raw.preview).toContain("Priya Patel");
    expect(raw.preview).toContain("Visa ending in 8831");
  });
});
