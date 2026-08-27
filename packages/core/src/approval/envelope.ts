import { z } from "zod";
import type { Client } from "@libsql/client";
import { isoUtc } from "@arbiter/shared";
import { ACTIONS, type ActionId, type FailureClassId } from "../decide/catalog.js";

export const ENVELOPE_VERSION = "env-v1";

export const envelopeSchema = z
  .object({
    envelope_version: z.literal(ENVELOPE_VERSION),
    enabled: z.boolean(),
    classes: z.array(z.enum(["SOFT_RETRYABLE", "HARD_METHOD_DEAD", "NETWORK_TIMEOUT", "RISK_FLAGGED", "UNKNOWN"])),
    channels: z.array(z.enum(ACTIONS)),
    max_attempts: z.number().int().min(0).max(10),
    max_amount_paise: z.number().int().min(1),
    require_quiet_ok: z.boolean(),
  })
  .strict();

export type AutonomyEnvelope = z.infer<typeof envelopeSchema>;

export const DENY_ALL: AutonomyEnvelope = {
  envelope_version: ENVELOPE_VERSION,
  enabled: false,
  classes: [],
  channels: [],
  max_attempts: 0,
  max_amount_paise: 1,
  require_quiet_ok: true,
};

export function parseEnvelope(raw: string): AutonomyEnvelope {
  if (raw === null || raw.trim() === "" || raw.trim() === "{}") {
    return DENY_ALL;
  }
  return envelopeSchema.parse(JSON.parse(raw));
}

export interface EnvelopeContext {
  failureClass: FailureClassId;
  actionId: ActionId;
  attemptsSoFar: number;
  amountPaise: number;
  quietHoursViolated: boolean;
}

export function evaluateEnvelope(
  env: AutonomyEnvelope,
  ctx: EnvelopeContext,
): { eligible: boolean; reasons: string[] } {
  if (!env.enabled) return { eligible: false, reasons: ["ENVELOPE_DISABLED"] };
  const reasons: string[] = [];
  if (ctx.actionId === "HUMAN_REVIEW") {
    return { eligible: false, reasons: ["HUMAN_REVIEW_NOT_AUTOAPPROVABLE"] };
  }
  if (!env.classes.includes(ctx.failureClass)) reasons.push("CLASS_NOT_ALLOWED");
  if (!env.channels.includes(ctx.actionId)) reasons.push("CHANNEL_NOT_ALLOWED");
  if (ctx.attemptsSoFar >= env.max_attempts) reasons.push("ATTEMPT_OVER_CAP");
  if (ctx.amountPaise > env.max_amount_paise) reasons.push("AMOUNT_OVER_CAP");
  if (env.require_quiet_ok && ctx.quietHoursViolated) reasons.push("QUIET_HOURS");
  return { eligible: reasons.length === 0, reasons };
}

export interface TenantEnvelopeResult {
  envelope: AutonomyEnvelope;
  corrupted: boolean;
}

export async function getTenantEnvelope(
  client: Client,
  tenantId: string,
): Promise<TenantEnvelopeResult> {
  const r = await client.execute({
    sql: `SELECT autonomy_envelope_json FROM tenants WHERE id = ?`,
    args: [tenantId],
  });
  if (r.rows.length === 0) {
    throw new Error(`getTenantEnvelope: unknown tenant ${tenantId}`);
  }
  const raw = String(r.rows[0]!.autonomy_envelope_json);
  try {
    return { envelope: parseEnvelope(raw), corrupted: false };
  } catch {
    return { envelope: DENY_ALL, corrupted: true };
  }
}

export async function setTenantEnvelope(
  client: Client,
  tenantId: string,
  envelope: AutonomyEnvelope,
): Promise<void> {
  envelopeSchema.parse(envelope);
  await client.execute({
    sql: `UPDATE tenants SET autonomy_envelope_json = ? WHERE id = ?`,
    args: [JSON.stringify(envelope), tenantId],
  });
}

export async function writeEnvelopeAlarm(
  client: Client,
  tenantId: string,
  nowMs?: number,
): Promise<void> {
  const existing = await client.execute({
    sql: `SELECT 1 FROM audit_log
          WHERE tenant_id = ? AND actor = 'SYSTEM' AND entry_type = 'TRIGGER'
            AND payload_json LIKE '%ENVELOPE_CORRUPT%'
          LIMIT 1`,
    args: [tenantId],
  });
  if (existing.rows.length > 0) return;
  await client.execute({
    sql: `INSERT INTO audit_log (ts_utc, tenant_id, event_id, actor, entry_type, payload_json)
          VALUES (?, ?, NULL, 'SYSTEM', 'TRIGGER', ?)`,
    args: [
      isoUtc(nowMs ?? Date.now()),
      tenantId,
      JSON.stringify({ alarm: "ENVELOPE_CORRUPT", action: "AUTO_APPROVAL_DISABLED" }),
    ],
  });
}
