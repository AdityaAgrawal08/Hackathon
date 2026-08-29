import { describe, it, expect } from "vitest";
import {
  simulateFailureTriage,
  approveProposal,
  completeRecovery,
  runBatchBenchmark,
  PRESETS,
} from "../../app/recovery.js";

describe("Recovery Command Center & Customer Simulator E2E (Task 1.1 - 1.5)", () => {
  // 11:00 AM IST on August 28, 2026 (strictly during active daytime)
  const DAYTIME_MS = Date.parse("2026-08-28T05:30:00.000Z");

  it("simulates full end-to-end failure triage for Salary Delay (SOFT_RETRYABLE)", async () => {
    const session = await simulateFailureTriage("SALARY_DELAY", "http://localhost:3000", undefined, DAYTIME_MS);

    expect(session).toBeDefined();
    expect(session.customerName).toBe("Rahul Sharma");
    expect(session.amountPaise).toBe(199900);
    expect(session.diagnosis.rootCause).toBe("INSUFFICIENT_FUNDS");
    expect(session.diagnosis.recommendedIntervention).toBe("RETRY_PAYDAY");
    expect(session.features.values.length).toBe(16);
    expect(["RETRY_PAYDAY", "ALTERNATE_UPI_LINK", "RECOVER_WHATSAPP", "REMINDER_LINK"]).toContain(
      session.decideOutput.chosen.action,
    );
    expect(session.autonomyStatus).toBe("AUTO_APPROVED");
    expect(session.messages.whatsappHi?.content).toContain("Rahul Sharma");
    expect(session.messages.whatsappHi?.content).toContain("₹1,999.00");
  });

  it("simulates Expired Card (HARD_METHOD_DEAD) requiring 1-click alternate method link", async () => {
    const session = await simulateFailureTriage("CARD_EXPIRED", "http://localhost:3000", undefined, DAYTIME_MS);

    expect(session.diagnosis.rootCause).toBe("METHOD_EXPIRED");
    expect(session.diagnosis.recommendedIntervention).toBe("ALTERNATE_METHOD");
    expect(["RECOVER_VIA_RAIL", "ALTERNATE_UPI_LINK", "REMINDER_LINK", "PARTIAL_COLLECT"]).toContain(
      session.decideOutput.chosen.action,
    );
    expect(session.messages.whatsappEn?.content).toContain("has expired");
  });

  it("quarantines high-risk bot spammer to HUMAN_REVIEW with 0 customer outreach", async () => {
    const session = await simulateFailureTriage("BOT_RISK", "http://localhost:3000", undefined, DAYTIME_MS);


    expect(session.diagnosis.rootCause).toBe("RISK_FLAGGED");
    expect(session.diagnosis.recommendedIntervention).toBe("ESCALATE_HUMAN");
    expect(session.decideOutput.chosen.action).toBe("HUMAN_REVIEW");
    expect(session.messages.whatsappEn).toBeNull();
    expect(session.messages.whatsappHi).toBeNull();
  });

  it("handles merchant approval and completes 1-click customer recovery", async () => {
    const session = await simulateFailureTriage("CARD_EXPIRED", "http://localhost:3000");
    expect(session.autonomyStatus).toBe("AWAITING_APPROVAL");

    const approved = await approveProposal(session.id);
    expect(approved).toBe(true);
    expect(session.autonomyStatus).toBe("APPROVED");

    const completed = await completeRecovery(session.id);
    expect(completed).toBe(true);
    expect(session.autonomyStatus).toBe("EXECUTED");
    expect(session.settledAtUtc).toBeDefined();
  });


  it("runs the 100-event Monte Carlo Batch Benchmark (The Bar) and measures lift", () => {
    const benchmark = runBatchBenchmark();

    expect(benchmark.batchSize).toBe(100);
    expect(benchmark.totalAtRiskPaise).toBeGreaterThan(0);
    expect(benchmark.arbiterRecoveredPaise).toBeGreaterThan(benchmark.controlRecoveredPaise);
    expect(benchmark.wastedRetriesSaved).toBeGreaterThan(0);
    expect(benchmark.spamComplaints).toBe(0);
    expect(benchmark.liftPercent).toContain("+");
  });
});
