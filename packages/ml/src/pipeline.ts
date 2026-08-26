import type { Client } from "@libsql/client";
import { isoUtc } from "@arbiter/shared";
import {
  decide,
  loadPolicyFile,
  resolvePolicyPath,
  type PolicyPack,
} from "@arbiter/core/decide";
import { computeFeatures } from "./features.js";
import { saveFeatures } from "./features_store.js";
import { scoreWithArtifact } from "./predict.js";
import { getIncumbent } from "./registry.js";
import type { ModelArtifact } from "./artifact.js";

export interface ProcessOptions {
  policy?: PolicyPack;
  model?: ModelArtifact;
  nowMs?: number;
}

export type PipelineStatus =
  | "PROPOSED"
  | "DUPLICATE"
  | "SKIPPED_TRAINING"
  | "SKIPPED_UNRESOLVED_CUSTOMER"
  | "SKIPPED_OPEN_PROPOSAL"
  | "NO_INCUMBENT";

export interface PipelineResult {
  eventId: string;
  status: PipelineStatus;
  proposalId?: string;
  chosenAction?: string;
  evPaise?: number;
  probability?: number;
}

interface EventRow {
  id: string;
  tenant_id: string;
  customer_id: string | null;
  amount_paise: number;
  failure_code: string;
  source: string;
  occurred_at_utc: string;
}

interface CustomerRow {
  id: string;
  payday_pattern_json: string;
  channel_responsiveness: number;
  prior_success_count: number;
  joined_at_utc: string;
  opted_out: number;
}

async function resolveContext(
  client: Client,
  event: EventRow,
): Promise<{ customer: CustomerRow; priorAmountsPaise: number[]; priorFailureCount: number }> {
  const cust = await client.execute({
    sql: `SELECT id, payday_pattern_json, channel_responsiveness, prior_success_count,
                 joined_at_utc, opted_out
          FROM customers WHERE id = ?`,
    args: [event.customer_id as string],
  });
  const customer = cust.rows[0] as unknown as CustomerRow;

  const seqRes = await client.execute({
    sql: `SELECT id, amount_paise, occurred_at_utc FROM payment_events
          WHERE customer_id = ? ORDER BY occurred_at_utc ASC, id ASC`,
    args: [event.customer_id as string],
  });
  const seq = seqRes.rows as unknown as Array<{
    id: string;
    amount_paise: number;
    occurred_at_utc: string;
  }>;
  const idx = seq.findIndex(
    (e) => e.id === event.id && e.occurred_at_utc === event.occurred_at_utc,
  );
  const prior = idx >= 0 ? seq.slice(0, idx) : [];
  return {
    customer,
    priorAmountsPaise: prior.map((p) => p.amount_paise),
    priorFailureCount: Math.max(idx, 0),
  };
}

export async function processEvent(
  client: Client,
  eventId: string,
  opts: ProcessOptions = {},
): Promise<PipelineResult> {
  const nowMs = opts.nowMs ?? Date.now();

  const evRes = await client.execute({
    sql: `SELECT id, tenant_id, customer_id, amount_paise, failure_code, source, occurred_at_utc
          FROM payment_events WHERE id = ?`,
    args: [eventId],
  });
  if (evRes.rows.length === 0) throw new Error(`processEvent: unknown event ${eventId}`);
  const event = evRes.rows[0] as unknown as EventRow;
  const base = { eventId };

  if (event.source === "TRAINING") return { ...base, status: "SKIPPED_TRAINING" };
  if (event.customer_id === null) {
    return { ...base, status: "SKIPPED_UNRESOLVED_CUSTOMER" };
  }

  const model = opts.model ?? (await getIncumbent(client));
  if (!model) return { ...base, status: "NO_INCUMBENT" };
  const policy = opts.policy ?? loadPolicyFile(resolvePolicyPath());

  const { customer, priorAmountsPaise, priorFailureCount } = await resolveContext(client, event);

  const computed = computeFeatures({
    failureCode: event.failure_code,
    amountPaise: event.amount_paise,
    occurredAtUtc: event.occurred_at_utc,
    priorFailureAmountsPaise: priorAmountsPaise,
    priorFailureCount,
    customer: {
      paydayPattern: JSON.parse(customer.payday_pattern_json) as Record<string, number>,
      channelResponsiveness: customer.channel_responsiveness,
      priorSuccessCount: customer.prior_success_count,
      joinedAtUtc: customer.joined_at_utc,
    },
  });
  await saveFeatures(client, [{ eventId, values: computed.values }], nowMs);

  const score = scoreWithArtifact(computed.values, model);

  const decision = decide({
    probability: score.probability,
    failureClass: computed.raw.failureClass,
    amountPaise: event.amount_paise,
    nowMs,
    policy,
    attemptsSoFar: priorFailureCount,
    lastContactAtMs: null,
    customerOptedOut: customer.opted_out !== 0,
    inferredPaydayDay: computed.raw.inferredPaydayDay,
  });

  const chosen = decision.chosen;
  const dedupeKey = `${eventId}|${model.id}|${policy.policy_version}`;
  const proposalId = `prop_${eventId}_${model.weightsSha256.slice(0, 8)}`;
  const nowIso = isoUtc(nowMs);

  const openConflict = await client.execute({
    sql: `SELECT 1 FROM proposals
          WHERE customer_id = ?
            AND event_id != ?
            AND state IN ('PROPOSED','AWAITING_APPROVAL','AUTO_APPROVED','APPROVED','EXECUTING')
          LIMIT 1`,
    args: [event.customer_id, eventId],
  });
  if (openConflict.rows.length > 0) {
    return { ...base, status: "SKIPPED_OPEN_PROPOSAL" };
  }

  let inserted;
  try {
    inserted = await client.execute({
      sql: `INSERT INTO proposals
              (id, event_id, customer_id, model_version_id, policy_version, action_json,
               ev_paise, confidence, attributions_json, narrative, state, state_version,
               dedupe_key, created_at_utc, updated_at_utc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'AWAITING_APPROVAL', 0, ?, ?, ?)
            ON CONFLICT(dedupe_key) DO NOTHING`,
      args: [
        proposalId,
        eventId,
        event.customer_id,
        model.id,
        policy.policy_version,
        JSON.stringify(chosen),
        chosen.evPaise,
        score.probability,
        JSON.stringify(score.attributions),
        dedupeKey,
        nowIso,
        nowIso,
      ],
    });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" && msg.includes("customer_id")) {
      return { ...base, status: "SKIPPED_OPEN_PROPOSAL" };
    }
    throw err;
  }

  if ((inserted.rowsAffected ?? 0) === 0) {
    return { ...base, status: "DUPLICATE" };
  }

  await client.execute({
    sql: `INSERT INTO audit_log (ts_utc, tenant_id, event_id, actor, entry_type, payload_json)
          VALUES (?, ?, ?, 'PIPELINE', 'DECISION', ?)`,
    args: [
      nowIso,
      event.tenant_id,
      eventId,
      JSON.stringify({
        proposalId,
        modelVersionId: model.id,
        policyVersion: policy.policy_version,
        probabilityBp: Math.round(score.probability * 10_000),
        chosenAction: chosen.action,
        evPaise: chosen.evPaise,
        scheduledForMs: chosen.scheduledForMs,
        refusals: decision.refusals,
        fallbackReason: decision.fallbackReason,
      }),
    ],
  });

  return {
    ...base,
    status: "PROPOSED",
    proposalId,
    chosenAction: chosen.action,
    evPaise: chosen.evPaise,
    probability: score.probability,
  };
}

export interface BatchSummary {
  proposed: number;
  duplicates: number;
  skippedTraining: number;
  skippedUnresolved: number;
  skippedOpenProposal: number;
}

export async function proposeForCorpus(
  client: Client,
  opts: ProcessOptions = {},
): Promise<BatchSummary> {
  const ids = await client.execute({
    sql: `SELECT id FROM payment_events WHERE source IN ('SEED', 'WEBHOOK')
          ORDER BY occurred_at_utc ASC, id ASC`,
  });

  const summary: BatchSummary = {
    proposed: 0,
    duplicates: 0,
    skippedTraining: 0,
    skippedUnresolved: 0,
    skippedOpenProposal: 0,
  };
  for (const row of ids.rows) {
    const r = await processEvent(client, String(row.id), opts);
    if (r.status === "PROPOSED") summary.proposed++;
    else if (r.status === "DUPLICATE") summary.duplicates++;
    else if (r.status === "SKIPPED_UNRESOLVED_CUSTOMER") summary.skippedUnresolved++;
    else if (r.status === "SKIPPED_OPEN_PROPOSAL") summary.skippedOpenProposal++;
  }
  return summary;
}
