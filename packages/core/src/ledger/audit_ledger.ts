/**
 * Cryptographically Verifiable Audit Ledger
 *
 * Appends immutable event records chained by SHA-256 hashes.
 * Ensures an tamper-evident audit trail for all recovery operations:
 * detection -> diagnosis -> EV decision -> outreach -> recovery -> reminder pruning.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Client } from "@libsql/client";
import { isoUtc } from "@arbiter/shared";

export interface AuditEntryInput {
  eventType: string;
  entityId: string;
  customerId?: string | null;
  actor?: string;
  payload?: Record<string, unknown>;
  nowMs?: number;
}

export interface AuditEntry {
  id: string;
  eventType: string;
  entityId: string;
  customerId: string | null;
  actor: string;
  payloadJson: string;
  prevHash: string;
  entryHash: string;
  createdAtUtc: string;
}

export function computeEntryHash(
  prevHash: string,
  eventType: string,
  entityId: string,
  payloadJson: string,
  createdAtUtc: string,
): string {
  return createHash("sha256")
    .update(`${prevHash}|${eventType}|${entityId}|${payloadJson}|${createdAtUtc}`)
    .digest("hex");
}

/**
 * Appends an entry to the audit ledger, maintaining the cryptographic hash chain.
 */
export async function appendAuditLedger(
  client: Client,
  input: AuditEntryInput,
): Promise<AuditEntry> {
  const nowMs = input.nowMs ?? Date.now();
  const createdAtUtc = isoUtc(nowMs);
  const payloadJson = JSON.stringify(input.payload ?? {});
  const actor = input.actor ?? "system";
  const customerId = input.customerId ?? null;

  // Retrieve previous entry hash for chain continuity
  const lastRow = await client.execute({
    sql: `SELECT entry_hash FROM audit_ledger ORDER BY created_at_utc DESC, rowid DESC LIMIT 1`,
    args: [],
  });
  const prevHash = lastRow.rows.length > 0 && lastRow.rows[0]?.entry_hash != null ? String(lastRow.rows[0].entry_hash) : "GENESIS";

  const entryHash = computeEntryHash(
    prevHash,
    input.eventType,
    input.entityId,
    payloadJson,
    createdAtUtc,
  );
  const id = `aud_${nowMs}_${randomBytes(4).toString("hex")}`;

  await client.execute({
    sql: `INSERT INTO audit_ledger (id, event_type, entity_id, customer_id, actor, payload_json, prev_hash, entry_hash, created_at_utc)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      input.eventType,
      input.entityId,
      customerId,
      actor,
      payloadJson,
      prevHash,
      entryHash,
      createdAtUtc,
    ],
  });

  return {
    id,
    eventType: input.eventType,
    entityId: input.entityId,
    customerId,
    actor,
    payloadJson,
    prevHash,
    entryHash,
    createdAtUtc,
  };
}

/**
 * Retrieves the chronological audit ledger for a specific entity (e.g. event, order).
 */
export async function getAuditLedgerForEntity(
  client: Client,
  entityId: string,
): Promise<AuditEntry[]> {
  const rows = await client.execute({
    sql: `SELECT id, event_type, entity_id, customer_id, actor, payload_json, prev_hash, entry_hash, created_at_utc
          FROM audit_ledger
          WHERE entity_id = ?
          ORDER BY created_at_utc ASC, rowid ASC`,
    args: [entityId],
  });

  return rows.rows.map((r) => ({
    id: String(r.id),
    eventType: String(r.event_type),
    entityId: String(r.entity_id),
    customerId: r.customer_id ? String(r.customer_id) : null,
    actor: String(r.actor),
    payloadJson: String(r.payload_json),
    prevHash: String(r.prev_hash),
    entryHash: String(r.entry_hash),
    createdAtUtc: String(r.created_at_utc),
  }));
}

/**
 * Verifies the integrity of the audit ledger cryptographic hash chain.
 */
export async function verifyAuditLedgerChain(
  client: Client,
): Promise<{ valid: boolean; totalEntries: number; brokenAtId?: string }> {
  const rows = await client.execute({
    sql: `SELECT id, event_type, entity_id, customer_id, actor, payload_json, prev_hash, entry_hash, created_at_utc
          FROM audit_ledger
          ORDER BY created_at_utc ASC, rowid ASC`,
    args: [],
  });

  let expectedPrevHash = "GENESIS";
  for (let i = 0; i < rows.rows.length; i++) {
    const row = rows.rows[i];
    if (!row) continue;
    const prevHash = String(row.prev_hash);
    const entryHash = String(row.entry_hash);
    const eventType = String(row.event_type);
    const entityId = String(row.entity_id);
    const payloadJson = String(row.payload_json);
    const createdAtUtc = String(row.created_at_utc);
    const id = String(row.id);

    if (prevHash !== expectedPrevHash) {
      return { valid: false, totalEntries: rows.rows.length, brokenAtId: id };
    }

    const calculatedHash = computeEntryHash(
      prevHash,
      eventType,
      entityId,
      payloadJson,
      createdAtUtc,
    );
    if (calculatedHash !== entryHash) {
      return { valid: false, totalEntries: rows.rows.length, brokenAtId: id };
    }

    expectedPrevHash = entryHash;
  }

  return { valid: true, totalEntries: rows.rows.length };
}
