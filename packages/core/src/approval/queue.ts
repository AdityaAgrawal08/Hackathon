import type { Client } from "@libsql/client";

export interface QueueRow {
  proposalId: string;
  eventId: string;
  customerId: string;
  failureCode: string;
  amountPaise: number;
  action: string;
  evPaise: number;
  confidence: number;
  modelVersionId: string;
  createdAtUtc: string;
}

export interface QueueGroup {
  key: string;
  count: number;
  totalEvPaise: number;
  proposals: QueueRow[];
}

export async function listApprovalQueue(client: Client, limit = 500): Promise<QueueRow[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`listApprovalQueue: limit must be positive integer, got ${limit}`);
  }
  const r = await client.execute({
    sql: `SELECT p.id, p.event_id, p.customer_id, e.failure_code, e.amount_paise,
                 p.action_json, p.ev_paise, p.confidence, p.model_version_id, p.created_at_utc
          FROM proposals p JOIN payment_events e ON e.id = p.event_id
          WHERE p.state = 'AWAITING_APPROVAL'
          ORDER BY p.ev_paise DESC, p.id ASC
          LIMIT ?`,
    args: [limit],
  });
  return r.rows.map((row) => {
    const action = JSON.parse(String(row.action_json)) as { action: string };
    return {
      proposalId: String(row.id),
      eventId: String(row.event_id),
      customerId: String(row.customer_id),
      failureCode: String(row.failure_code),
      amountPaise: Number(row.amount_paise),
      action: action.action,
      evPaise: Number(row.ev_paise),
      confidence: Number(row.confidence),
      modelVersionId: String(row.model_version_id),
      createdAtUtc: String(row.created_at_utc),
    };
  });
}

export function groupQueue(rows: readonly QueueRow[]): QueueGroup[] {
  const byKey = new Map<string, QueueRow[]>();
  for (const row of rows) {
    const code = row.failureCode;
    const key = `${code}×${row.action}`;
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }
  return [...byKey.entries()]
    .map(([key, proposals]) => ({
      key,
      count: proposals.length,
      totalEvPaise: proposals.reduce((s, p) => s + p.evPaise, 0),
      proposals,
    }))
    .sort((a, b) => b.totalEvPaise - a.totalEvPaise || (a.key < b.key ? -1 : 1));
}
