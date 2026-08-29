import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app, dbClient } from "../../app/server.js";

describe("Phase 6: End-to-End Orchestration & Full-Pipeline Integration Tests", () => {
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

  it("Task 6.1 & 6.2: wires telemetry to 16-D features, calibrated ML, and EV engine", async () => {
    const res = await fetch(`${baseUrl}/api/recovery/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preset: "SALARY_DELAY",
        simulatedTimeMs: DAYTIME_MS,
        autonomyThresholdPaise: 200000, // ₹2,000
      }),
    });

    expect(res.status).toBe(200);
    const session = await res.json();

    // 6.1 Verification
    expect(session.id).toMatch(/^prop_/);
    expect(session.diagnosis.rootCause).toBe("INSUFFICIENT_FUNDS");
    expect(session.diagnosis.class).toBe("SOFT_RETRYABLE");
    expect(session.features.values.length).toBe(16);

    // 6.2 Verification
    expect(session.probability).toBeGreaterThan(0);
    expect(session.decideOutput.chosen.action).toBeDefined();
    expect(session.decideOutput.ranked.length).toBeGreaterThan(1);
    expect(session.autonomyStatus).toBe("AUTO_APPROVED");
  });

  it("Task 6.3: dispatches autonomous provider outreach with local token injection", async () => {
    const res = await fetch(`${baseUrl}/api/recovery/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preset: "SALARY_DELAY",
        simulatedTimeMs: DAYTIME_MS,
      }),
    });

    const session = await res.json();
    expect(session.dispatchResult).toBeDefined();
    expect(["SENT", "DELIVERED", "QUEUED"]).toContain(session.dispatchResult.status);
    expect(session.dispatchResult.providerName).toBeDefined();

    // Zero-Trust Fraud Quarantine Check: High Risk must NOT dispatch outreach
    const fraudRes = await fetch(`${baseUrl}/api/recovery/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preset: "BOT_RISK",
        simulatedTimeMs: DAYTIME_MS,
      }),
    });

    const fraudSession = await fraudRes.json();
    expect(fraudSession.autonomyStatus).toBe("AWAITING_APPROVAL");
    expect(fraudSession.dispatchResult).toBeUndefined();
  });

  it("Task 6.4: supports live SSE status stream with reactive payment completion", async () => {
    // 1. Ingest session
    const triageRes = await fetch(`${baseUrl}/api/recovery/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preset: "SALARY_DELAY",
        simulatedTimeMs: DAYTIME_MS,
      }),
    });
    const session = await triageRes.json();

    // 2. Open SSE stream with abort controller so test exits cleanly
    const controller = new AbortController();
    const ssePromise = fetch(`${baseUrl}/api/status/${session.recoveryToken}`, {
      signal: controller.signal,
    });

    const sseRes = await ssePromise;
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");

    // 3. Complete recovery payment
    const compRes = await fetch(`${baseUrl}/api/recovery/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposalId: session.id }),
    });
    const compData = await compRes.json();
    expect(compData.success).toBe(true);

    // Clean up SSE connection
    controller.abort();
  });


  it("Task 6.5 & 6.8: returns full forensic transaction trace with SHA-256 cryptographic proofs", async () => {
    // 1. Triage a session
    const triageRes = await fetch(`${baseUrl}/api/recovery/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preset: "SALARY_DELAY",
        simulatedTimeMs: DAYTIME_MS,
      }),
    });
    const session = await triageRes.json();

    // 2. Complete payment
    await fetch(`${baseUrl}/api/recovery/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposalId: session.id }),
    });

    // 3. Query trace API
    const traceRes = await fetch(`${baseUrl}/api/recovery/trace/${session.id}`);
    expect(traceRes.status).toBe(200);
    const trace = await traceRes.json();

    expect(trace.proposalId).toBe(session.id);
    expect(trace.recoveryToken).toBe(session.recoveryToken);
    expect(trace.isRecovered).toBe(true);
    expect(trace.steps.length).toBeGreaterThanOrEqual(3);

    // Verify cryptographic SHA-256 hash on every single step
    for (const step of trace.steps) {
      expect(step.sha256Hash).toMatch(/^[a-f0-9]{64}$/);
      expect(step.step).toBeDefined();
      expect(step.timestampUtc).toBeDefined();
    }
  });
});
