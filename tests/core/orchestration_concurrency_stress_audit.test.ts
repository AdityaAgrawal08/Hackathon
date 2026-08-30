import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import { app, dbClient } from "../../app/server.js";
import {
  simulateFailureTriage,
  getRecoveryTrace,
  completeRecovery,
  defaultOutreachRouter,
} from "../../app/recovery.js";
import {
  OutreachRouter,
  type OutreachProvider,
  type OutreachPayload,
  type ProviderDispatchResult,
} from "../../packages/core/src/index.js";

describe("Aggressive Industry-Grade Audit: Concurrency, Failover Cascade & Re-Entrancy Invariants", () => {
  let server: Server;
  let baseUrl: string;
  const DAYTIME_MS = Date.parse("2026-08-28T05:30:00.000Z"); // 11:00 AM IST

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

  describe("Audit 1: High-Concurrency Burst Stress (100 Parallel Ingestions)", () => {
    it(
      "handles 100 concurrent triage requests with zero race conditions, data corruption, or hash drift",
      async () => {
        const burstPromises = Array.from({ length: 100 }, (_, i) => {
          const amountPaise = (1000 + i * 50) * 100;
          return fetch(`${baseUrl}/api/recovery/triage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              customPreset: {
                customerName: `Burst Customer ${i}`,
                customerPhone: `+91 98000 ${String(i).padStart(5, "0")}`,
                amountPaise,
                failureCode: i % 2 === 0
                  ? "BAD_REQUEST_PAYMENT_ACCOUNT_INSUFFICIENT_BALANCE"
                  : "BAD_REQUEST_PAYMENT_CARD_EXPIRED",
              },
              simulatedTimeMs: DAYTIME_MS,
              autonomyThresholdPaise: 250000,
            }),
          }).then((res) => res.json());
        });

        const sessions = await Promise.all(burstPromises);
        expect(sessions.length).toBe(100);

        // Verify every session is unique and structurally sound
        const ids = new Set(sessions.map((s) => s.id));
        expect(ids.size).toBe(100);

        // Concurrently query trace API for all 100 sessions
        const tracePromises = sessions.map((s) =>
          fetch(`${baseUrl}/api/recovery/trace/${s.id}`).then((res) => res.json()),
        );
        const traces = await Promise.all(tracePromises);

        for (let i = 0; i < 100; i++) {
          const trace = traces[i];
          expect(trace.proposalId).toBe(sessions[i].id);
          expect(trace.steps.length).toBeGreaterThanOrEqual(3);

          // Verify SHA-256 integrity on every single step of all 100 sessions
          for (const step of trace.steps) {
            const recomputed = createHash("sha256")
              .update(JSON.stringify(step.payload))
              .digest("hex");
            expect(step.sha256Hash).toBe(recomputed);
          }
        }
      },
      60000,
    );
  });


  describe("Audit 2: Multi-Channel Provider Failover Cascade & Circuit Breakers", () => {
    it("cascades from failing primary provider to secondary provider without dropping outreach", async () => {
      const customRouter = new OutreachRouter();

      // 1. Primary provider that fails
      const failingPrimary: OutreachProvider = {
        name: "failing_msg91",
        channel: "SMS",
        send: async () => {
          throw new Error("Telecom Gateway 503 Service Unavailable");
        },
      };

      // 2. Secondary backup provider that succeeds
      const backupSecondary: OutreachProvider = {
        name: "backup_route",
        channel: "SMS",
        send: async (payload: OutreachPayload) => {
          return {
            providerName: "backup_route",
            channel: "SMS",
            externalMessageId: `backup_${payload.proposalId}`,
            status: "SENT",
            costPaise: 25,
            dispatchedAtUtc: new Date().toISOString(),
          };
        },
      };

      customRouter.registerProvider(failingPrimary);
      customRouter.registerProvider(backupSecondary);

      const payload: OutreachPayload = {
        proposalId: "prop_failover_test",
        failureClass: "SOFT_RETRYABLE",
        action: "RECOVER_SMS",
        recipient: { customerName: "Test User", phone: "+91 98765 00000" },
        amountPaise: 199900,
        paymentLinkUrl: "http://localhost:3000/pay/tok_test",
        language: "EN",
        rawErrorReason: "INSUFFICIENT_FUNDS",
      };

      const result = await customRouter.dispatch("SMS", payload, DAYTIME_MS);
      expect(result.status).toBe("SENT");
      expect(result.providerName).toBe("backup_route");
      expect(result.externalMessageId).toBe("backup_prop_failover_test");
    });

    it("strictly suppresses SMS/Voice outreach for numbers on the NCPR DND Registry", async () => {
      const dndPhone = "+91 99999 11111";
      defaultOutreachRouter.addDndNumber(dndPhone);

      const payload: OutreachPayload = {
        proposalId: "prop_dnd_test",
        failureClass: "SOFT_RETRYABLE",
        action: "RECOVER_SMS",
        recipient: { customerName: "DND Customer", phone: dndPhone },
        amountPaise: 199900,
        paymentLinkUrl: "http://localhost:3000/pay/tok_dnd",
        language: "EN",
        rawErrorReason: "INSUFFICIENT_FUNDS",
      };

      const result = await defaultOutreachRouter.dispatch("SMS", payload, DAYTIME_MS);
      expect(result.status).toBe("SUPPRESSED_DND");
      expect(result.costPaise).toBe(0);
    });
  });

  describe("Audit 3: Webhook Re-Entrancy & Double-Debit Invariant", () => {
    it("handles out-of-order payment completions idempotently without duplicate credits", async () => {
      const triageRes = await fetch(`${baseUrl}/api/recovery/triage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preset: "SALARY_DELAY",
          simulatedTimeMs: DAYTIME_MS,
        }),
      });
      const session = await triageRes.json();

      // 1. Complete payment first time -> Success
      const compRes1 = await fetch(`${baseUrl}/api/recovery/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalId: session.id }),
      });
      const comp1 = await compRes1.json();
      expect(comp1.success).toBe(true);

      // 2. Complete payment second time (duplicate webhook / double-click) -> Idempotent false / no double-addition
      const compRes2 = await fetch(`${baseUrl}/api/recovery/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposalId: session.id }),
      });
      const comp2 = await compRes2.json();
      expect(comp2.success).toBe(false); // Already executed, double-debit blocked

      // Verify trace records exact outcome
      const traceRes = await fetch(`${baseUrl}/api/recovery/trace/${session.id}`);
      const trace = await traceRes.json();
      expect(trace.isRecovered).toBe(true);
      expect(trace.autonomyStatus).toBe("EXECUTED");
    });
  });
});
