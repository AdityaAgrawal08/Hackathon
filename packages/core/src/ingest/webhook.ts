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

/* ── async domain webhook ingestion (inbox_events) ─────────────── */

export interface IngestDomainWebhookInput {
  client: Client;
  rawBody: Buffer | string;
  signature: string | null;
  webhookSecret: string;
  provider?: "razorpay" | "local";
  nowMs?: number;
}

export interface IngestDomainWebhookResult {
  statusCode: number;
  status: "ACCEPTED" | "DUPLICATE" | "REJECTED" | "SECURITY_ANOMALY";
  eventId?: string;
  message?: string;
}

export async function ingestDomainWebhook(
  input: IngestDomainWebhookInput,
): Promise<IngestDomainWebhookResult> {
  const nowMs = input.nowMs ?? Date.now();
  const nowIso = isoUtc(nowMs);
  const provider = input.provider ?? "razorpay";
  const rawBuf = Buffer.isBuffer(input.rawBody) ? input.rawBody : Buffer.from(input.rawBody, "utf8");
  const rawStr = rawBuf.toString("utf8");

  // 1. Verify HMAC Signature
  if (!input.signature || !verifySignature(rawStr, input.signature, input.webhookSecret)) {
    return {
      statusCode: 400,
      status: "REJECTED",
      message: "Invalid webhook signature.",
    };
  }

  // 2. Parse & validate envelope
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawStr);
  } catch {
    return {
      statusCode: 400,
      status: "REJECTED",
      message: "Malformed JSON payload.",
    };
  }

  const eventType = String(parsed.event || "unknown");
  const payloadObj = (parsed.payload as Record<string, unknown>) || {};
  const paymentObj = (payloadObj.payment as { entity?: { id?: string; order_id?: string; amount?: number; status?: string } })?.entity;
  const eventId = String(parsed.id || (paymentObj?.id ? `evt_${paymentObj.id}` : `evt_wh_${Date.now()}`));
  const payloadHash = createHmac("sha256", "payload_hash_key").update(rawBuf).digest("hex");

  // 3. Check inbox_events for duplicate or anomaly
  const existing = await input.client.execute({
    sql: `SELECT id, payload_hash, status FROM inbox_events WHERE id = ?`,
    args: [eventId],
  });

  if (existing.rows.length > 0) {
    const row = existing.rows[0] as unknown as { payload_hash: string; status: string };
    if (row.payload_hash === payloadHash) {
      // Idempotent duplicate delivery
      return {
        statusCode: 200,
        status: "DUPLICATE",
        eventId,
        message: "Duplicate event acknowledged.",
      };
    } else {
      // Same event ID with different payload -> Security anomaly
      return {
        statusCode: 400,
        status: "SECURITY_ANOMALY",
        eventId,
        message: "Duplicate event ID with conflicting payload detected.",
      };
    }
  }

  // 4. Durably persist to inbox_events with PENDING status
  await input.client.execute({
    sql: `INSERT INTO inbox_events
            (id, provider, event_type, payload_json, payload_hash, status, received_at_utc)
          VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`,
    args: [eventId, provider, eventType, rawStr, payloadHash, nowIso],
  });

  // 5. Asynchronously project payment state in background (non-blocking for HTTP response)
  projectInboxEvent(input.client, eventId, eventType, parsed, nowIso).catch((err) => {
    console.error(`projectInboxEvent failed for ${eventId}:`, err);
  });

  return {
    statusCode: 200,
    status: "ACCEPTED",
    eventId,
    message: "Event ingested successfully.",
  };
}

async function projectInboxEvent(
  client: Client,
  eventId: string,
  eventType: string,
  parsed: Record<string, unknown>,
  nowIso: string,
): Promise<void> {
  const payloadObj = (parsed.payload as Record<string, unknown>) || {};
  const pay = (payloadObj.payment as { entity?: { id?: string; order_id?: string; amount?: number; status?: string } })?.entity;

  if (pay && pay.order_id && pay.id) {
    if (eventType === "payment.captured" || pay.status === "captured") {
      // 1. Find payment intent by order_id or provider lookup
      const piRes = await client.execute({
        sql: `SELECT pi.id, pi.tenant_id, pi.amount_paise, cs.order_id
              FROM payment_intents pi
              JOIN checkout_sessions cs ON cs.token = pi.checkout_token
              WHERE cs.order_id = ? OR pi.order_id = ?
              LIMIT 1`,
        args: [pay.order_id, pay.order_id],
      });

      if (piRes.rows.length > 0) {
        const intent = piRes.rows[0] as unknown as { id: string; tenant_id: string; amount_paise: number };
        await client.batch(
          [
            {
              sql: `INSERT INTO local_settlements
                      (id, payment_intent_id, idem_key, provider_payment_id, amount_paise, currency, settled_at_utc)
                    VALUES (?, ?, ?, ?, ?, 'INR', ?)
                    ON CONFLICT(payment_intent_id) DO NOTHING`,
              args: [`set_${intent.id}`, intent.id, `idem_${intent.id}`, pay.id, pay.amount ?? intent.amount_paise, nowIso],
            },
            {
              sql: `UPDATE payment_intents
                    SET status = 'SUCCEEDED', client_visible = 'SUCCEEDED', resolved_at_utc = ?
                    WHERE id = ?`,
              args: [nowIso, intent.id],
            },
          ],
          "write",
        );
      }
    }
  }

  // Mark inbox event PROCESSED
  await client.execute({
    sql: `UPDATE inbox_events SET status = 'PROCESSED', processed_at_utc = ? WHERE id = ?`,
    args: [nowIso, eventId],
  });
}

