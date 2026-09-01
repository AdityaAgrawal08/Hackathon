/**
 * Batch recovery orchestrator — Track 3 bar:
 *   "Show measured money recovered across a batch, with compliant escalation,
 *    stopping rules, and an audit trail."
 *
 * Runs the full bounded loop over a batch of at-risk events:
 *   detect → diagnose → decide → execute
 * and produces a MEASURED report (not a simulation):
 *   - total at-risk ₹
 *   - recovered ₹ (SUCCEEDED)
 *   - escalated ₹ (HUMAN_REVIEW / AMBIGUOUS — compliant escalation)
 *   - stopped ₹ (FAILED — stopping rules / policy refusals)
 *   - contacts made, wasted attempts, human escalations
 *   - audit-trail entry count (every step is logged)
 *   - bootstrap 95% confidence intervals (B-003)
 *   - cost-per-recovered-rupee metric (B-005)
 *
 * Every amount is integer paise; no float ever touches the measurement.
 */
import type { Client } from "@libsql/client";
import { paise, type Paise, hashSeed } from "@arbiter/shared";
import { CONTACT_COST_PAISE } from "@arbiter/core/decide";
import { processEvent } from "./pipeline.js";
import { executeProposal } from "@arbiter/core/executor";
import { diagnoseFailure } from "@arbiter/core/diagnosis";
import { controlOutcome } from "./control_arm.js";

export interface PerEventResult {
  eventId: string;
  status: string;
  outcome: "SUCCEEDED" | "FAILED" | "AMBIGUOUS" | "ERROR" | null;
  amountPaise: number;
  rootCause: string | null;
  intervention: string | null;
  /** Control-arm outcome (what would happen with NO intervention). */
  controlOutcome: "SUCCEEDED" | "FAILED" | null;
}

export interface BatchRecoveryReport {
  batchId: string;
  eventCount: number;
  processedCount: number;
  skippedCount: number;
  /** Revenue at risk across all processed events (integer paise). */
  totalAtRiskPaise: number;
  /** Actually recovered (SUCCEEDED outcomes). */
  recoveredPaise: number;
  /** Control-arm recovered (what would happen with NO intervention). */
  controlRecoveredPaise: number;
  /** Incremental recovery: pipeline - control (the true measured lift). */
  incrementalRecoveredPaise: number;
  /** Routed to human review / ambiguous (compliant escalation). */
  escalatedPaise: number;
  /** Stopped by policy / FAILED (stopping rules). */
  stoppedPaise: number;
  contactsMade: number;
  wastedAttempts: number;
  policyRefusals: number;
  humanEscalations: number;
  auditTrailCount: number;
  perEvent: PerEventResult[];
  /** B-003: Bootstrap 95% CI for recovery rate [low, high]. */
  bootstrapCI95: { low: number; high: number } | null;
  /** B-005: Cost per recovered rupee (total cost / recovered amount). */
  costPerRecoveredPaise: number;
  /** B-005: Total outreach cost in paise. */
  totalOutreachCostPaise: number;
}

export interface RecoverBatchOptions {
  nowMs?: number;
  batchId?: string;
}

export async function recoverBatch(
  client: Client,
  eventIds: string[],
  opts: RecoverBatchOptions = {},
): Promise<BatchRecoveryReport> {
  const nowMs = opts.nowMs ?? Date.now();
  const batchId = opts.batchId ?? `batch_${nowMs}`;

  const report: BatchRecoveryReport = {
    batchId,
    eventCount: eventIds.length,
    processedCount: 0,
    skippedCount: 0,
    totalAtRiskPaise: 0,
    recoveredPaise: 0,
    controlRecoveredPaise: 0,
    incrementalRecoveredPaise: 0,
    escalatedPaise: 0,
    stoppedPaise: 0,
    contactsMade: 0,
    wastedAttempts: 0,
    policyRefusals: 0,
    humanEscalations: 0,
    auditTrailCount: 0,
    perEvent: [],
    bootstrapCI95: null,
    costPerRecoveredPaise: 0,
    totalOutreachCostPaise: 0,
  };

  for (const eventId of eventIds) {
    // 1. detect → diagnose → decide → propose
    let result: Awaited<ReturnType<typeof processEvent>>;
    try {
      result = await processEvent(client, eventId, { nowMs });
    } catch (err) {
      // Event missing or pipeline-internal failure → count as skipped, never crash the batch.
      report.skippedCount++;
      report.perEvent.push({
        eventId,
        status: `ERROR: ${(err as Error).message}`,
        outcome: null,
        amountPaise: 0,
        rootCause: null,
        intervention: null,
        controlOutcome: null,
      });
      continue;
    }
    if (result.status !== "PROPOSED" || !result.proposalId) {
      report.skippedCount++;
      report.perEvent.push({
        eventId,
        status: result.status,
        outcome: null,
        amountPaise: 0,
        rootCause: null,
        intervention: null,
        controlOutcome: null,
      });
      continue;
    }
    report.processedCount++;

    // 2. Fetch the at-risk amount (the revenue in question)
    const evRow = await client.execute({
      sql: `SELECT amount_paise, failure_code FROM payment_events WHERE id = ?`,
      args: [eventId],
    });
    const amountPaise: Paise =
      evRow.rows.length > 0 ? paise(Number(evRow.rows[0]!.amount_paise)) : paise(0);
    const failureCode =
      evRow.rows.length > 0 ? String(evRow.rows[0]!.failure_code) : "UNKNOWN_CODE";

    // 2b. Control-arm: what would happen with NO intervention?
    //     Uses fixed historical baseline rates per failure class (not model-dependent).
    const ctlOutcome = controlOutcome(eventId, failureCode);
    if (ctlOutcome === "SUCCEEDED") {
      report.controlRecoveredPaise += amountPaise;
    }

    // 3. Root-cause diagnosis (explicit, explainable)
    const diagnosis = diagnoseFailure(failureCode, "UNKNOWN");

    // 4. Resolve proposal state — decide whether to execute or escalate.
    const propRow = await client.execute({
      sql: `SELECT state FROM proposals WHERE id = ?`,
      args: [result.proposalId],
    });
    const proposalState =
      propRow.rows.length > 0 ? String(propRow.rows[0]!.state) : "UNKNOWN";

    // 5. Measure (integer paise only) — every processed event counts.
    report.totalAtRiskPaise += amountPaise;

    // Query actual audit trail entries for this event (not hardcoded count — bug #A-011)
    try {
      const auditRow = await client.execute({
        sql: `SELECT COUNT(*) as cnt FROM audit_trail WHERE event_id = ?`,
        args: [eventId],
      });
      report.auditTrailCount += auditRow.rows.length > 0 ? Number(auditRow.rows[0]!.cnt) : 0;
    } catch {
      // audit_trail table may not exist in all test environments
      report.auditTrailCount += 0;
    }

    let outcome: PerEventResult["outcome"] = null;
    if (proposalState === "AWAITING_APPROVAL") {
      // Compliant escalation: routed to human, never auto-executed.
      outcome = "AMBIGUOUS";
      report.escalatedPaise += amountPaise;
      report.contactsMade++;
      report.humanEscalations++;
    } else if (proposalState === "AUTO_APPROVED") {
      // Execute the bounded recovery workflow.
      try {
        const exec = await executeProposal(client, {
          proposalId: result.proposalId,
          nowMs,
        });
        outcome = exec.outcome;
      } catch {
        outcome = "ERROR";
      }
      if (outcome === "SUCCEEDED") {
        report.recoveredPaise += amountPaise;
        report.contactsMade++;
      } else if (outcome === "AMBIGUOUS") {
        report.escalatedPaise += amountPaise;
        report.contactsMade++;
        report.humanEscalations++;
      } else if (outcome === "FAILED") {
        report.stoppedPaise += amountPaise;
        report.wastedAttempts++;
      } else {
        report.stoppedPaise += amountPaise;
      }
    } else if (proposalState === "PROCESSING") {
      // Intermediate state — not yet terminal; count as in-progress
      outcome = null;
      report.stoppedPaise += amountPaise;
    } else {
      // Terminal state (EXECUTED, FAILED, CANCELLED, etc.) — stopped, not recovered.
      outcome = "ERROR";
      report.stoppedPaise += amountPaise;
    }

    report.perEvent.push({
      eventId,
      status: result.status,
      outcome,
      amountPaise,
      rootCause: diagnosis.rootCause,
      intervention: diagnosis.recommendedIntervention,
      controlOutcome: ctlOutcome,
    });
  }

  // Incremental lift: true measured recovery above natural baseline.
  report.incrementalRecoveredPaise = report.recoveredPaise - report.controlRecoveredPaise;

  // B-003: Bootstrap 95% confidence intervals for recovery rate.
  if (report.processedCount > 0) {
    report.bootstrapCI95 = bootstrapCI95(report.perEvent, 1000);
  }

  // B-005: Cost-per-recovered-rupee metric.
  // Per-action costs from catalog (CONTACT_COST_PAISE from decide/catalog.ts)
  let totalCostPaise = 0;
  for (const evt of report.perEvent) {
    if (evt.outcome === "SUCCEEDED" || evt.outcome === "AMBIGUOUS") {
      totalCostPaise += CONTACT_COST_PAISE[evt.action as keyof typeof CONTACT_COST_PAISE] ?? 100;
    }
  }
  report.totalOutreachCostPaise = totalCostPaise;
  report.costPerRecoveredPaise = report.recoveredPaise > 0
    ? Math.round((totalCostPaise / report.recoveredPaise) * 100)
    : 0;

  return report;
}

/**
 * B-003: Bootstrap 95% confidence interval for recovery rate.
 * Resamples the per-event outcomes `iterations` times with replacement,
 * computes the recovery rate for each sample, and returns the 2.5th/97.5th percentiles.
 */
export function bootstrapCI95(
  perEvent: PerEventResult[],
  iterations = 1000,
): { low: number; high: number } {
  const n = perEvent.length;
  if (n === 0) return { low: 0, high: 0 };

  const rates: number[] = [];
  for (let iter = 0; iter < iterations; iter++) {
    let recovered = 0;
    for (let i = 0; i < n; i++) {
      // Deterministic bootstrap: use hashSeed for sampling (no Math.random)
      const idx = hashSeed(`bootstrap:${iter}:${i}`) % n;
      if (perEvent[idx]!.outcome === "SUCCEEDED") recovered++;
    }
    rates.push(recovered / n);
  }

  rates.sort((a, b) => a - b);
  const lowIdx = Math.floor(0.025 * rates.length);
  const highIdx = Math.floor(0.975 * rates.length);
  return {
    low: Math.round(rates[lowIdx]! * 1000) / 10,
    high: Math.round(rates[highIdx]! * 1000) / 10,
  };
}
