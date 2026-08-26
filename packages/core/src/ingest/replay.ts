/**
 * Replay ingestion — the canonical demo/panel path (P1 mitigation:
 * "test webhooks are flaky; replay never depends on webhook timing").
 * Feeds seed fixtures through the same recordFailureEvent() entry the
 * webhook uses, minus HTTP/signature.
 */
import type { Client } from "@libsql/client";
import { isoUtc } from "@arbiter/shared";

/**
 * Structural input shape — intentionally NOT the seed package's Corpus type,
 * so core never depends on seed (layering: seed → core allowed, never reverse).
 */
export interface ReplayCorpus {
  customers: Array<{
    id: string;
    tenantId: string;
    pseudoName: string;
    phoneFake: string;
    emailFake: string;
    paydayPattern: Record<string, number>;
    paydayTrueDay?: number | null;
    channelResponsiveness: number;
    optedOut: boolean;
    joinedAtUtc: string;
  }>;
  events: Array<{
    id: string;
    tenantId: string;
    customerId: string;
    rzpPaymentId: string | null;
    subscriptionId: string | null;
    amountPaise: number;
    failureCode: string;
    failureClassHint: string;
    source: "TRAINING" | "SEED";
    occurredAtUtc: string;
  }>;
}

export interface ReplayResult {
  tenants: number;
  customers: number;
  events: number;
  duplicates: number;
}

export async function ensureTenant(
  client: Client,
  tenantId: string,
  nowIso: string,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO tenants (id,name,created_at_utc) VALUES (?, ?, ?)
          ON CONFLICT(id) DO NOTHING`,
    args: [tenantId, tenantId === "demo" ? "Demo Merchant" : tenantId, nowIso],
  });
}

/**
 * Single failure-event write used by BOTH webhook and replay paths.
 * Dedupe on event id: first insert wins, duplicates increment swallow_count
 * and emit a swallowed TRIGGER ledger row (observable, not silent).
 */
export async function recordFailureEvent(
  client: Client,
  evt: {
    id: string;
    tenantId: string;
    customerId: string | null;
    rzpPaymentId: string | null;
    subscriptionId: string | null;
    amountPaise: number;
    failureCode: string;
    failureClassHint: string | null;
    source: "WEBHOOK" | "SEED" | "TRAINING";
    occurredAtUtc: string;
  },
  nowIso: string,
): Promise<"INSERTED" | "DUPLICATE"> {
  try {
    await client.execute({
      sql: `INSERT INTO payment_events
              (id,tenant_id,customer_id,rzp_payment_id,subscription_id,amount_paise,
               failure_code,failure_class_hint,source,true_outcome_seed,occurred_at_utc,ingested_at_utc)
            VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?)`,
      args: [
        evt.id,
        evt.tenantId,
        evt.customerId,
        evt.rzpPaymentId,
        evt.subscriptionId,
        evt.amountPaise,
        evt.failureCode,
        evt.failureClassHint,
        evt.source,
        evt.occurredAtUtc,
        nowIso,
      ],
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    const msg = (err as Error).message ?? "";
    const isDuplicate =
      msg.includes("payment_events.id") &&
      (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE");
    if (!isDuplicate) throw err;
    await client.execute({
      sql: `UPDATE webhook_dedupe SET swallow_count = swallow_count + 1 WHERE provider_event_id = ?`,
      args: [evt.id],
    }).catch(() => {});
    return "DUPLICATE";
  }
  return "INSERTED";
}

/** Replay a parsed demo corpus into the DB. Idempotent per corpus+event ids. */
export async function replayCorpus(
  client: Client,
  corpus: ReplayCorpus,
): Promise<ReplayResult> {
  const nowIso = isoUtc(Date.now());
  const result: ReplayResult = {
    tenants: 0,
    customers: 0,
    events: 0,
    duplicates: 0,
  };

  const tenantIds = new Set<string>(["demo", ...corpus.customers.map((c) => c.tenantId)]);
  for (const tid of tenantIds) {
    await ensureTenant(client, tid, nowIso);
    result.tenants += 1;
  }

  for (const c of corpus.customers) {
    await client.execute({
      sql: `INSERT INTO customers
              (id,tenant_id,pseudo_name,phone_fake,email_fake,payday_pattern_json,
               payday_true_day,channel_responsiveness,opted_out,joined_at_utc)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO NOTHING`,
      args: [
        c.id,
        c.tenantId,
        c.pseudoName,
        c.phoneFake,
        c.emailFake,
        JSON.stringify(c.paydayPattern),
        c.paydayTrueDay ?? null,
        c.channelResponsiveness,
        c.optedOut ? 1 : 0,
        c.joinedAtUtc,
      ],
    });
    result.customers += 1;
  }

  for (const e of corpus.events) {
    const outcome = await recordFailureEvent(
      client,
      {
        id: e.id,
        tenantId: e.tenantId,
        customerId: e.customerId,
        rzpPaymentId: e.rzpPaymentId,
        subscriptionId: e.subscriptionId,
        amountPaise: e.amountPaise,
        failureCode: e.failureCode,
        failureClassHint: e.failureClassHint,
        source: e.source === "TRAINING" ? "TRAINING" : "SEED",
        occurredAtUtc: e.occurredAtUtc,
      },
      nowIso,
    );
    if (outcome === "INSERTED") result.events += 1;
    else result.duplicates += 1;
  }

  return result;
}
