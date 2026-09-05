import { describe, it, expect, beforeAll } from "vitest";
import { createServer } from "node:http";
import { app } from "../../app/server.js";

describe("TASK-007 & TASK-008: Platform Interplay Server Endpoints", () => {
  let baseUrl: string;
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address() as any;
        baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });

    return () => {
      server.close();
    };
  });

  describe("Bank Downtime Webhook & Pre-Flight Rail Steering", () => {
    it("POST /api/webhooks/razorpay-downtime records downtime and updates active list", async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/razorpay-downtime`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bank: "HDFC",
          status: "DOWN",
          severity: "HIGH",
          instrument: "upi",
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.bank).toBe("HDFC");
      expect(data.status).toBe("DOWN");

      const getRes = await fetch(`${baseUrl}/api/rail-health/downtimes`);
      expect(getRes.status).toBe(200);
      const getData = (await getRes.json()) as any;
      expect(getData.activeDowntimes.some((d: any) => d.bank === "HDFC")).toBe(true);
    });

    it("POST /api/checkout/validate-rail intercepts degraded rail pre-flight", async () => {
      const res = await fetch(`${baseUrl}/api/checkout/validate-rail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerVpa: "anand@okhdfcbank",
          amountPaise: 499900,
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.decision.steered).toBe(true);
      expect(data.decision.originalRail).toBe("HDFC");
      expect(data.decision.recommendedRail).toBe("AXIS");
      expect(data.decision.suggestedVpa).toBe("anand@okaxis");
      expect(data.decision.userMessage).toContain("servers are experiencing high downtime");
    });

    it("POST /api/webhooks/razorpay-downtime clears downtime when resolved", async () => {
      const res = await fetch(`${baseUrl}/api/webhooks/razorpay-downtime`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bank: "HDFC",
          status: "UP",
          severity: "LOW",
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);

      const valRes = await fetch(`${baseUrl}/api/checkout/validate-rail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerVpa: "anand@okhdfcbank",
          amountPaise: 499900,
        }),
      });
      const valData = (await valRes.json()) as any;
      expect(valData.decision.steered).toBe(false);
    });
  });

  describe("SaaS Recurring Subscription Mandates (UPI Autopay) Sequencer", () => {
    it("POST /api/subscriptions/fail schedules RBI 24h pre-debit notice for 06:30 AM IST", async () => {
      const res = await fetch(`${baseUrl}/api/subscriptions/fail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscriptionId: "sub_test_001",
          customerName: "Acme Analytics",
          customerPhone: "+919876500001",
          customerEmail: "billing@acme.com",
          planName: "Enterprise Tier Monthly",
          amountPaise: 1499900,
          failureCode: "INSUFFICIENT_FUNDS",
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.plan.rbiCompliant).toBe(true);
      expect(data.plan.strategy).toBe("SALARY_WINDOW_0630");
      expect(data.plan.customerMessage).toContain("06:30 AM");

      const listRes = await fetch(`${baseUrl}/api/subscriptions/mandates`);
      expect(listRes.status).toBe(200);
      const listData = (await listRes.json()) as any;
      expect(listData.mandates.some((m: any) => m.id === "sub_test_001")).toBe(true);
    });

    it("POST /api/subscriptions/retry-now/:id marks mandate as recovered", async () => {
      const res = await fetch(`${baseUrl}/api/subscriptions/retry-now/sub_test_001`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.recovered).toBe(true);
    });
  });
});
