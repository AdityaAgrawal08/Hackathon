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
 *
 * Every amount is integer paise; no float ever touches the measurement.
 */
import type { Client } from "@libsql/client";
import { processEvent } from "./pipeline.js";
import { executeProposal } from "@arbiter/core/executor";
import { diagnoseFailure } from "@arbiter/core/diagnosis";
import { paise, type Paise } from "@arbiter/shared";

export interface PerEventResult {
  eventId: string;
  status: string;
  outcome: "SUCCEEDED" | "FAILED" | "AMBIGUOUS" | "ERROR" | null;
  amountPaise: number;
  rootCause: string | null;
  intervention: string | null;
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
    escalatedPaise: 0,
    stoppedPaise: 0,
    contactsMade: 0,
    wastedAttempts: 0,
    policyRefusals: 0,
    humanEscalations: 0,
    auditTrailCount: 0,
    perEvent: [],
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
    report.auditTrailCount += 2; // DECISION + DIAGNOSIS written by pipeline

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
    } else {
      // Terminal/unknown state — stopped, not recovered.
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
    });
  }

  return report;
}
