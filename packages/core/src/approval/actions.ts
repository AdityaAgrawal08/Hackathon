import type { Client } from "@libsql/client";
import { transition, type TransitionResult } from "./state_machine.js";

export interface ActOptions {
  actor: string;
  note?: string | null;
}

export async function approveProposal(
  client: Client,
  proposalId: string,
  opts: ActOptions,
): Promise<TransitionResult> {
  return transition(client, { proposalId, toState: "APPROVED", ...opts });
}

export async function rejectProposal(
  client: Client,
  proposalId: string,
  opts: ActOptions,
): Promise<TransitionResult> {
  return transition(client, { proposalId, toState: "REJECTED", ...opts });
}

const CANCELLABLE = [
  "PROPOSED",
  "AWAITING_APPROVAL",
  "AUTO_APPROVED",
  "APPROVED",
] as const;

export async function cancelProposal(
  client: Client,
  proposalId: string,
  reason: string,
): Promise<TransitionResult> {
  return transition(client, {
    proposalId,
    toState: "CANCELLED",
    actor: "SYSTEM",
    note: reason,
  });
}

export interface BatchItemResult {
  proposalId: string;
  ok: boolean;
  reason?: string;
}

export interface BatchSummary {
  approved: number;
  skipped: number;
  items: BatchItemResult[];
}

export async function batchApprove(
  client: Client,
  proposalIds: readonly string[],
  opts: ActOptions,
): Promise<BatchSummary> {
  const summary: BatchSummary = { approved: 0, skipped: 0, items: [] };
  for (const proposalId of proposalIds) {
    const r = await approveProposal(client, proposalId, opts);
    if (r.ok) {
      summary.approved++;
      summary.items.push({ proposalId, ok: true });
    } else {
      summary.skipped++;
      summary.items.push({ proposalId, ok: false, reason: r.reason });
    }
  }
  return summary;
}
