/**
 * Automated Tests for Task 6.10 / ENG-11: Engagement Telemetry Webhooks & EV Batch Sequencer
 */
import { describe, it, expect } from "vitest";
import {
  sequenceBatchByExpectedValue,
  type BatchCandidate,
} from "../../packages/core/src/decide/batch_sequencer.js";

describe("Task 6.10 / ENG-11: Engagement Telemetry & EV Batch Sequencer", () => {
  describe("1. Mathematical EV Priority Sequencing", () => {
    it("prioritizes portal clicks and suppresses hard-bounced credentials", () => {
      const candidates: BatchCandidate[] = [
        {
          id: "cand_unopened",
          amountPaise: 500000, // ₹5,000
          pRecovery: 0.5,
          costPaise: 18,
          engagementStatus: "DELIVERED_UNOPENED", // 0.8x
        },
        {
          id: "cand_clicked",
          amountPaise: 500000, // ₹5,000
          pRecovery: 0.5,
          costPaise: 18,
          engagementStatus: "CLICKED_PORTAL", // 2.5x
        },
        {
          id: "cand_bounced",
          amountPaise: 1000000, // ₹10,000
          pRecovery: 0.8,
          costPaise: 18,
          engagementStatus: "HARD_BOUNCED", // 0.0x -> Suppressed
        },
        {
          id: "cand_opened",
          amountPaise: 500000, // ₹5,000
          pRecovery: 0.5,
          costPaise: 18,
          engagementStatus: "OPENED_MESSAGE", // 1.5x
        },
      ];

      const result = sequenceBatchByExpectedValue(candidates);

      expect(result.totalInputCount).toBe(4);
      expect(result.eligibleCount).toBe(3);
      expect(result.suppressedCount).toBe(1);

      // Verify top candidate is the clicked one
      expect(result.candidates[0].id).toBe("cand_clicked");
      expect(result.candidates[0].priorityScore).toBeGreaterThan(result.candidates[1].priorityScore!);

      // Verify 2nd candidate is the opened one
      expect(result.candidates[1].id).toBe("cand_opened");

      // Verify 3rd candidate is the unopened one
      expect(result.candidates[2].id).toBe("cand_unopened");

      // Verify suppressed candidate is at the bottom with score 0
      expect(result.candidates[3].id).toBe("cand_bounced");
      expect(result.candidates[3].suppressed).toBe(true);
      expect(result.candidates[3].priorityScore).toBe(0);
    });
  });

  describe("2. Real-Time Engagement Webhooks", () => {
    it("ingests Brevo events and MSG91 DLR webhooks cleanly", async () => {
      const { app } = await import("../../app/server.js");
      const server = app.listen(0);
      const addr = server.address() as any;
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      try {
        // 1. Brevo Opened Event
        const brevoRes = await fetch(`${baseUrl}/api/webhooks/brevo/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "opened",
            email: "aditya@arbiter.live",
            "message-id": "msg_brevo_999",
          }),
        });
        const brevoData = await brevoRes.json() as any;
        expect(brevoRes.status).toBe(200);
        expect(brevoData.received).toBe(true);

        // 2. MSG91 Delivered Event
        const msg91Res = await fetch(`${baseUrl}/api/webhooks/msg91/dlr`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: "DELIVERED",
            requestId: "req_msg91_888",
            mobile: "919876543210",
          }),
        });
        const msg91Data = await msg91Res.json() as any;
        expect(msg91Res.status).toBe(200);
        expect(msg91Data.received).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
