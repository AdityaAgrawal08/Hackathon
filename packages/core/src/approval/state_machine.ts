import type { Client } from "@libsql/client";
import { isoUtc } from "@arbiter/shared";

export const TERMINAL_STATES = ["EXECUTED", "FAILED", "CANCELLED", "EDITED", "REJECTED"] as const;

export type ProposalState =
  | "PROPOSED"
  | "AWAITING_APPROVAL"
  | "AUTO_APPROVED"
  | "APPROVED"
  | "EDITED"
  | "REJECTED"
  | "CANCELLED"
  | "EXECUTING"
  | "EXECUTED"
  | "FAILED";

export const ALLOWED_TRANSITIONS: Record<ProposalState, readonly ProposalState[]> = {
  PROPOSED: ["AWAITING_APPROVAL", "AUTO_APPROVED", "CANCELLED"],
  AWAITING_APPROVAL: ["APPROVED", "EDITED", "REJECTED", "CANCELLED"],
  AUTO_APPROVED: ["EXECUTING", "CANCELLED"],
  APPROVED: ["EXECUTING", "CANCELLED"],
  EDITED: [],
  REJECTED: [],
  CANCELLED: [],
  EXECUTING: ["EXECUTED", "FAILED"],
  EXECUTED: [],
  FAILED: [],
};

export type HumanDecision = "APPROVE" | "EDIT" | "REJECT";

const DECISION_BY_TARGET: Partial<Record<ProposalState, HumanDecision>> = {
  APPROVED: "APPROVE",
  EDITED: "EDIT",
  REJECTED: "REJECT",
};

export interface TransitionResult {
  ok: boolean;
  reason?: "UNKNOWN_PROPOSAL" | "ILLEGAL_TRANSITION" | "CONCURRENT_MODIFICATION" | "TERMINAL_STATE";
  fromState?: string;
  stateVersion?: number;
}

export interface TransitionInput {
  proposalId: string;
  toState: ProposalState;
  actor: string;
  note?: string | null;
}

function isTerminal(state: string): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export async function transition(
  client: Client,
  input: TransitionInput,
): Promise<TransitionResult> {
  const nowIso = isoUtc(Date.now());

  const cur = await client.execute({
    sql: `SELECT id, state, state_version FROM proposals WHERE id = ?`,
    args: [input.proposalId],
  });
  if (cur.rows.length === 0) {
    return { ok: false, reason: "UNKNOWN_PROPOSAL" };
  }
  const row = cur.rows[0]!;
  const fromState = String(row.state) as ProposalState;
  const stateVersion = Number(row.state_version);

  if (!isLegalTransition(fromState, input.toState)) {
    return {
      ok: false,
      reason: isTerminal(fromState) ? "TERMINAL_STATE" : "ILLEGAL_TRANSITION",
      fromState,
      stateVersion,
    };
  }

  const updated = await client.execute({
    sql: `UPDATE proposals
          SET state = ?, state_version = state_version + 1, updated_at_utc = ?
          WHERE id = ? AND state = ? AND state_version = ?`,
    args: [input.toState, nowIso, input.proposalId, fromState, stateVersion],
  });
  if ((updated.rowsAffected ?? 0) === 0) {
    return { ok: false, reason: "CONCURRENT_MODIFICATION", fromState, stateVersion };
  }

  const decision = DECISION_BY_TARGET[input.toState];
  if (decision) {
    await client.execute({
      sql: `INSERT INTO approval_records (id, proposal_id, actor, decision, note, decided_at_utc)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        `apr_${input.proposalId}_${stateVersion + 1}`,
        input.proposalId,
        input.actor,
        decision,
        input.note ?? null,
        nowIso],
    });
  }

  await client.execute({
    sql: `INSERT INTO audit_log (ts_utc, tenant_id, event_id, actor, entry_type, payload_json)
          SELECT ?, e.tenant_id, p.event_id, ?, 'APPROVAL', ?
          FROM proposals p JOIN payment_events e ON e.id = p.event_id
          WHERE p.id = ?`,
    args: [
      nowIso,
      input.actor,
      JSON.stringify({ proposalId: input.proposalId, from: fromState, to: input.toState, note: input.note ?? null }),
      input.proposalId,
    ],
  });

  return { ok: true, fromState, stateVersion: stateVersion + 1 };
}

export function isLegalTransition(from: string, to: string): boolean {
  const allowed = ALLOWED_TRANSITIONS[from as ProposalState];
  return Array.isArray(allowed) && allowed.includes(to as ProposalState);
}
