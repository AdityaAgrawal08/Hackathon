import { describe, it, expect } from "vitest";
import { MSG91SmsProvider, MSG91_DLT_TEMPLATES } from "../../packages/core/src/messaging/providers/msg91.js";
import type { OutreachPayload } from "../../packages/core/src/messaging/types.js";

describe("Task 2.3: MSG91 Indian DLT SMS Provider", () => {
  const payload: OutreachPayload = {
    tenantId: "demo",
    proposalId: "prop_msg91_001",
    idempotencyKey: "idem_msg91_123",
    recipient: {
      customerId: "cust_123",
      name: "Rahul Sharma",
      phone: "+91 98765 43210",
      language: "HI",
    },
    amountPaise: 199900,
    failureClass: "SOFT_RETRYABLE",
    instrumentDescription: "HDFC Bank ending in 4120",
    recoveryUrl: "https://pay.arbiter.in/r/tok_msg91_1",
  };

  it("selects the correct registered DLT template for Soft Retryable failure", async () => {
    const provider = new MSG91SmsProvider();
    const result = await provider.send(payload);

    expect(result.providerName).toBe("msg91");
    expect(result.channel).toBe("SMS");
    expect(result.status).toBe("SENT");
    expect(result.costPaise).toBe(0); // Simulated — no real cost
    expect(result.externalMessageId).toContain("msg91_sim_");

    const raw = result.rawResponse as { simulated: boolean; phone: string };
    expect(raw.simulated).toBe(true);
    expect(raw.phone).toBe("919876543210");
    expect(MSG91_DLT_TEMPLATES.SOFT_RETRYABLE.dltId).toBe("1407168923450011");
  });

  it("selects DLT template for expired cards (HARD_METHOD_DEAD)", async () => {
    const provider = new MSG91SmsProvider();
    const deadPayload: OutreachPayload = {
      ...payload,
      failureClass: "HARD_METHOD_DEAD",
      instrumentDescription: "Visa ending in 8831",
    };

    const result = await provider.send(deadPayload);
    expect(MSG91_DLT_TEMPLATES.HARD_METHOD_DEAD.dltId).toBe("1407168923450012");
    expect(result.status).toBe("SENT");
  });
});
