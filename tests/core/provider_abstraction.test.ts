import { describe, it, expect } from "vitest";
import { OutreachRouter } from "../../packages/core/src/messaging/router.js";
import type {
  OutreachProvider,
  OutreachPayload,
  ProviderDispatchResult,
} from "../../packages/core/src/messaging/types.js";

class MockEmailProvider implements OutreachProvider {
  readonly name = "mock_email";
  readonly channel = "EMAIL" as const;

  async send(payload: OutreachPayload): Promise<ProviderDispatchResult> {
    return {
      providerName: this.name,
      channel: this.channel,
      externalMessageId: `msg_${payload.proposalId}`,
      status: "SENT",
      costPaise: 10,
      dispatchedAtUtc: new Date().toISOString(),
    };
  }

  verifyWebhookSignature(): boolean {
    return true;
  }
}

class MockSmsProvider implements OutreachProvider {
  readonly name = "mock_sms";
  readonly channel = "SMS" as const;

  async send(payload: OutreachPayload): Promise<ProviderDispatchResult> {
    return {
      providerName: this.name,
      channel: this.channel,
      externalMessageId: `sms_${payload.proposalId}`,
      status: "SENT",
      costPaise: 25,
      dispatchedAtUtc: new Date().toISOString(),
    };
  }

  verifyWebhookSignature(): boolean {
    return true;
  }
}

describe("Task 2.1: Unified Provider Abstraction & Router", () => {
  const samplePayload: OutreachPayload = {
    tenantId: "demo",
    proposalId: "prop_12345",
    idempotencyKey: "idem_abc",
    recipient: {
      customerId: "cust_1",
      name: "Aditya",
      email: "aditya@example.com",
      phone: "+919876543210",
      language: "EN",
    },
    amountPaise: 199900,
    failureClass: "SOFT_RETRYABLE",
    instrumentDescription: "HDFC Card ending in 4120",
    recoveryUrl: "https://pay.arbiter.in/r/tok_123",
  };

  it("routes payload to registered channel provider during daytime", async () => {
    const router = new OutreachRouter();
    router.registerProvider(new MockEmailProvider());
    router.registerProvider(new MockSmsProvider());

    const daytimeMs = Date.parse("2026-08-28T10:00:00.000Z"); // 15:30 IST
    const res = await router.dispatch("EMAIL", samplePayload, daytimeMs);

    expect(res.status).toBe("SENT");
    expect(res.providerName).toBe("mock_email");
    expect(res.costPaise).toBe(10);
  });

  it("suppresses non-email outreach during quiet hours (22:00 to 08:00 IST)", async () => {
    const router = new OutreachRouter();
    router.registerProvider(new MockSmsProvider());

    const nightMs = Date.parse("2026-08-28T17:00:00.000Z"); // 22:30 IST
    const res = await router.dispatch("SMS", samplePayload, nightMs);

    expect(res.status).toBe("SUPPRESSED_QUIET_HOURS");
    expect(res.costPaise).toBe(0);
  });

  it("suppresses SMS outreach for numbers registered in NCPR DND cache", async () => {
    const router = new OutreachRouter();
    router.registerProvider(new MockSmsProvider());
    router.addDndNumber("+919876543210");

    const daytimeMs = Date.parse("2026-08-28T10:00:00.000Z");
    const res = await router.dispatch("SMS", samplePayload, daytimeMs);

    expect(res.status).toBe("SUPPRESSED_DND");
    expect(res.costPaise).toBe(0);
  });
});
