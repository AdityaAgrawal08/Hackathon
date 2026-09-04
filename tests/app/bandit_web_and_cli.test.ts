/**
 * Automated Verification Suite for Phase 4: LinUCB Contextual Bandit Web Endpoints
 *
 * Verifies:
 * 1. POST /api/bandit/select-arm (Enterprise 5-arm and Legacy 4-arm)
 * 2. POST /api/bandit/feedback (Policy updates, reward accumulation, dimension validation)
 * 3. GET /api/bandit/arms-state (Real-time snapshot, pull counts, summary metrics)
 * 4. Rigorous input validation & error codes.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app, dbClient } from "../../app/server.js";
import { runMigrations } from "../../packages/core/src/db/migrate.js";

describe("Phase 4: LinUCB Contextual Bandit Web Endpoints", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await runMigrations(dbClient);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as any;
        baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  describe("1. POST /api/bandit/select-arm", () => {
    it("selects enterprise arm for valid transaction parameters", async () => {
      const res = await fetch(`${baseUrl}/api/bandit/select-arm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountPaise: 499900,
          dwellTimeSeconds: 45,
          openLatencyMins: 15,
          priorFailureCount: 1,
          channelResponsiveness: 0.8,
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.armType).toBe("enterprise");
      expect(data.dimension).toBe(5);
      expect(data.selection).toBeDefined();
      expect(typeof data.selection.action).toBe("string");
      expect(data.selection.ucbScore).toBeGreaterThanOrEqual(0);
      expect(data.selection.context).toHaveLength(5);
    });

    it("selects legacy 4-arm bandit when armType=legacy is requested", async () => {
      const res = await fetch(`${baseUrl}/api/bandit/select-arm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticketAmountPaise: 299900,
          dwellTimeSeconds: 20,
          priorFailureCount: 2,
          channelResponsiveness: 0.5,
          armType: "legacy",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.armType).toBe("legacy");
      expect(data.dimension).toBe(4);
      expect(data.selection.context).toHaveLength(4);
    });

    it("accepts a pre-computed raw context vector directly", async () => {
      const res = await fetch(`${baseUrl}/api/bandit/select-arm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          armType: "enterprise",
          context: [0.1, 0.2, 0.3, 0.4, 0.5],
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.selection.context).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
    });

    it("rejects request missing both amount and context with 400 Bad Request", async () => {
      const res = await fetch(`${baseUrl}/api/bandit/select-arm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Valid amountPaise or ticketAmountPaise is required");
    });
  });

  describe("2. POST /api/bandit/feedback", () => {
    it("updates enterprise arm with observed reward and increments pull count", async () => {
      const res = await fetch(`${baseUrl}/api/bandit/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "SMS_1TAP_UPI",
          reward: 1.0,
          context: [0.5, 0.2, 0.1, 0.0, 0.9],
          armType: "enterprise",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.updatedAction || data.action).toBe("SMS_1TAP_UPI");
      expect(data.armState.pullCount).toBeGreaterThanOrEqual(1);
      expect(data.armState.totalReward).toBeGreaterThanOrEqual(1.0);
    });

    it("rejects invalid action name for enterprise bandit with 400", async () => {
      const res = await fetch(`${baseUrl}/api/bandit/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "NON_EXISTENT_ARM",
          reward: 0.5,
          context: [0.1, 0.2, 0.3, 0.4, 0.5],
          armType: "enterprise",
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("is not a valid enterprise arm");
    });

    it("rejects context vector with incorrect dimension with 400", async () => {
      const res = await fetch(`${baseUrl}/api/bandit/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "SMS_1TAP_UPI",
          reward: 0.5,
          context: [0.1, 0.2], // Only 2 dims instead of 5
          armType: "enterprise",
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("requires a 5-dimensional context vector");
    });

    it("rejects non-numeric reward with 400", async () => {
      const res = await fetch(`${baseUrl}/api/bandit/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "SMS_1TAP_UPI",
          reward: "high",
          context: [0.1, 0.2, 0.3, 0.4, 0.5],
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Valid reward number");
    });
  });

  describe("3. GET /api/bandit/arms-state", () => {
    it("returns enterprise bandit state with summary metrics", async () => {
      const res = await fetch(`${baseUrl}/api/bandit/arms-state?armType=enterprise`);
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.armType).toBe("enterprise");
      expect(data.dimension).toBe(5);
      expect(data.arms).toBeDefined();
      expect(data.arms.SMS_1TAP_UPI).toBeDefined();
      expect(data.summary).toBeInstanceOf(Array);
      expect(data.summary).toHaveLength(5);

      const smsSummary = data.summary.find((s: any) => s.arm === "SMS_1TAP_UPI");
      expect(smsSummary).toBeDefined();
      expect(smsSummary.pullCount).toBeGreaterThanOrEqual(1);
    });

    it("returns legacy bandit state when queried", async () => {
      const res = await fetch(`${baseUrl}/api/bandit/arms-state?armType=legacy`);
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.armType).toBe("legacy");
      expect(data.dimension).toBe(4);
      expect(data.summary).toHaveLength(4);
    });
  });
});
