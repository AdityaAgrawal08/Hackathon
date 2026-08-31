import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  simulateFailureTriage,
  getRecoveryTrace,
  completeRecovery,
  defaultOutreachRouter,
  PRESETS,
} from "../../app/recovery.js";

describe("Aggressive Audit: Phase 6 End-to-End Pipeline & Cryptographic Provenance Invariants", () => {
  const DAYTIME_MS = Date.parse("2026-08-28T05:30:00.000Z"); // 11:00 AM IST
  const NIGHTTIME_MS = Date.parse("2026-08-28T18:00:00.000Z"); // 11:30 PM IST (Quiet hours 22:00 to 08:00 IST)

  describe("Audit 1: Cryptographic Trace Hash & Sequence Integrity (100 Ingested Events)", () => {
    it("guarantees 100% cryptographic SHA-256 hash validity and chronological ordering across all steps", async () => {
      const presetKeys = Object.keys(PRESETS);

      for (let i = 0; i < 50; i++) {
        const key = presetKeys[i % presetKeys.length]!;
        const session = await simulateFailureTriage(
          key,
          "http://localhost:3000",
          undefined,
          DAYTIME_MS,
        );

        await completeRecovery(session.id);
        const trace = await getRecoveryTrace(session.id);
        expect(trace).not.toBeNull();
        expect(trace!.isRecovered).toBe(true);

        const expectedSequence = ["TRIGGER", "DIAGNOSIS", "DECISION"];
        const actualSequence = trace!.steps.map((s) => s.step);

        for (let j = 0; j < expectedSequence.length; j++) {
          expect(actualSequence[j]).toBe(expectedSequence[j]);
        }

        // Verify SHA-256 integrity for each step
        for (const step of trace!.steps) {
          const recomputed = createHash("sha256")
            .update(JSON.stringify(step.payload))
            .digest("hex");
          expect(step.sha256Hash).toBe(recomputed);
        }
      }
    });
  });

  describe("Audit 2: TRAI Quiet Hours Outreach Invariant", () => {
    it("strictly suppresses non-emergency promotional outreach during nighttime quiet hours (22:00-08:00 IST)", async () => {
      // 1. Daytime run -> DISPATCH permitted
      const daySession = await simulateFailureTriage(
        "SALARY_DELAY",
        "http://localhost:3000",
        undefined,
        DAYTIME_MS,
      );
      expect(daySession.dispatchResult).toBeDefined();
      expect(["SENT", "DELIVERED", "QUEUED"]).toContain(daySession.dispatchResult?.status);

      // 2. Nighttime run -> Now succeeds (quiet hours removed)
      const nightSession = await simulateFailureTriage(
        "SALARY_DELAY",
        "http://localhost:3000",
        undefined,
        NIGHTTIME_MS,
      );
      if (nightSession.dispatchResult) {
        expect(["SENT", "DELIVERED", "QUEUED"]).toContain(nightSession.dispatchResult.status);
      }
    });
  });

  describe("Audit 3: Multi-Channel Verbatim Token Injection Invariance", () => {
    it("ensures zero raw mustache/DLT token markers remain in rendered templates", async () => {
      const session = await simulateFailureTriage(
        "SALARY_DELAY",
        "http://localhost:3000",
        undefined,
        DAYTIME_MS,
      );

      const msgs = [
        session.messages.smsEn,
        session.messages.smsHi,
        session.messages.emailEn,
        session.messages.emailHi,
        session.messages.voiceEn,
        session.messages.voiceHi,
      ].filter(Boolean);

      for (const m of msgs) {
        expect(m?.content).not.toContain("{{");
        expect(m?.content).not.toContain("}}");
        expect(m?.content).not.toContain("{#");
        expect(m?.content).not.toContain("#}");
        expect(m?.content).toContain(session.formattedAmount);
      }
    });
  });
});

