/**
 * Webhook ingestion — "detects revenue at risk" entry point.
 *
 * Bug coverage:
 *  P1-B7  HMAC computed over RAW body bytes BEFORE any JSON parsing.
 *  P1-B8  provider-event-id dedupe table; duplicates counted, never re-ingested.
 *  I-7    fail closed: malformed payloads are rejected + logged, never guessed.
 *
 * Framework-agnostic: takes raw strings, returns plain results. The Next.js
 * route handler (P6) is a thin wrapper over processWebhook().
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Client } from "@libsql/client";
import { z } from "zod";
import { isoUtc } from "@arbiter/shared";
import { ensureTenant } from "./replay.js";

export interface IngestDeps {
  client: Client;
  /** Injected clock — determinism in tests, real time in prod. */
  nowMs?: () => number;
  /** Tenant scope for this ingestion stream (default: demo merchant). */
  tenantId?: string;
}

export interface WebhookResult {
  status: "ACCEPTED" | "IGNORED" | "DUPLICATE" | "REJECTED";
  reason?: string;
  eventId?: string;
}

const razorpayWebhookSchema = z.object({
  event: z.string(),
  payload: z
    .object({
      payment: z
        .object({
          entity: z.object({
            id: z.string(),
            amount: z.number().int().positive(),
            status: z.string(),
            error_description: z.string().optional(),
            error_source: z.string().optional(),
            notes: z.record(z.string(), z.unknown()).optional(),
          }),
        })
        .optional(),
      subscription: z
        .object({ entity: z.object({ id: z.string() }) })
        .optional(),
    })
    .passthrough(),
});

/** Constant-time HMAC check. Signature format: hex sha256 of raw body. */
export function verifySignature(
  rawBody: string,
  signatureHex: string | null,
  secret: string,
): boolean {
  if (!signatureHex) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHex, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function recordTrigger(
  client: Client,
  args: { eventId: string; tenantId: string; nowIso: string; payloadSummary: string },
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO audit_log (ts_utc,tenant_id,event_id,actor,entry_type,payload_json)
          VALUES (?, ?, ?,'PIPELINE','TRIGGER',?)`,
    args: [args.nowIso, args.tenantId, args.eventId, args.payloadSummary],
  });
}

async function logSecurityRejection(
  client: Client,
  args: { tenantId: string; nowIso: string; reason: string },
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO audit_log (ts_utc,tenant_id,event_id,actor,entry_type,payload_json)
          VALUES (?, ?, NULL,'SYSTEM','REFUSAL',?)`,
    args: [args.nowIso, args.tenantId, JSON.stringify({ security: true, reason: args.reason })],
  });
}

/**
 * Process a Razorpay-shaped webhook. Returns a discriminated result; NEVER
 * throws for business reasons (invalid sig / bad payload are results).
 */
export async function processWebhook(
  deps: IngestDeps,
  rawBody: string,
  signatureHex: string | null,
  webhookSecret: string,
): Promise<WebhookResult> {
  const nowMs = deps.nowMs ?? Date.now;
  const nowIso = isoUtc(nowMs());
  const tenantId = deps.tenantId ?? "demo";

  // Fresh-environment safety: tenant must exist before any event row (FK).
  await ensureTenant(deps.client, tenantId, nowIso);

  // ── trust boundary first: signature over RAW bytes (P1-B7)
  if (!verifySignature(rawBody, signatureHex, webhookSecret)) {
    await logSecurityRejection(deps.client, { tenantId, nowIso, reason: "invalid_signature" });
    return { status: "REJECTED", reason: "invalid_signature" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    await logSecurityRejection(deps.client, { tenantId, nowIso, reason: "malformed_json" });
    return { status: "REJECTED", reason: "malformed_json" };
  }

  const parsedSafe = razorpayWebhookSchema.safeParse(parsed);
  if (!parsedSafe.success) {
    await logSecurityRejection(deps.client, { tenantId, nowIso, reason: "schema_mismatch" });
    return { status: "REJECTED", reason: "schema_mismatch" };
  }
  const body = parsedSafe.data;

  // Only failure events matter downstream; everything else is acknowledged.
  if (body.event !== "payment.failed" || !body.payload.payment) {
    return { status: "IGNORED", reason: `event:${body.event}` };
  }
  const pay = body.payload.payment.entity;
  const eventId = `evt_wh_${pay.id}`;
  const subscriptionId = body.payload.subscription?.entity?.id ?? null;

  // ── provider-event dedupe (P1-B8): claim BEFORE inserting the event row.
  try {
    await deps.client.execute({
      sql: `INSERT INTO webhook_dedupe (provider_event_id, first_seen_utc, swallow_count)
            VALUES (?, ?, 0)`,
      args: [eventId, nowIso],
    });
  } catch {
    await deps.client.execute({
      sql: `UPDATE webhook_dedupe SET swallow_count = swallow_count + 1 WHERE provider_event_id = ?`,
      args: [eventId],
    });
    await recordTrigger(deps.client, {
      eventId,
      tenantId,
      nowIso,
      payloadSummary: JSON.stringify({ swallowed: true, duplicateDelivery: true }),
    });
    return { status: "DUPLICATE", eventId };
  }

  // Failure code: prefer explicit source/code, else description head, else UNKNOWN.
  const failureCode =
    (pay.error_source && normalizeCode(pay.error_source)) ||
    (pay.error_description ? normalizeCode(pay.error_description) : "UNKNOWN_CODE");

  await deps.client.execute({
    sql: `INSERT INTO payment_events
            (id,tenant_id,customer_id,rzp_payment_id,subscription_id,amount_paise,
             failure_code,failure_class_hint,source,true_outcome_seed,occurred_at_utc,ingested_at_utc)
          VALUES (?,?,?,?,?,?,?,?, 'WEBHOOK', NULL, ?, ?)`,
    args: [
      eventId,
      tenantId,
      null, // unresolved until enrichment (schema: customerId nullable)
      pay.id,
      subscriptionId,
      pay.amount,
      failureCode,
      null, // failure_class_hint — classification belongs to PREDICT, not ingestion
      nowIso,
      nowIso,
    ],
  });

  await recordTrigger(deps.client, {
    eventId,
    tenantId,
    nowIso,
    payloadSummary: JSON.stringify({ failureCode, amountPaise: pay.amount }),
  });

  return { status: "ACCEPTED", eventId };
}

function normalizeCode(s: string): string {
  const head = s.trim().toUpperCase().replace(/[^A-Z0-9_ ]/g, "").split(/\s+/)[0] ?? "";
  return head.length > 0 && head.length <= 32 ? head : "UNKNOWN_CODE";
}
