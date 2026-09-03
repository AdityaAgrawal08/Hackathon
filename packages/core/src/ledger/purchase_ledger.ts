/**
 * Immutable Credential-Bound Purchase Ledger (Task 6.9 / PURCH-10)
 *
 * Persists append-only transaction history per credential_id without storing PII.
 * Computes temporal behavioral features (recency, velocity, lifetime success rate, ticket z-score).
 */
import type { Client } from "@libsql/client";

export interface PurchaseLedgerEntry {
  id?: string;
  credentialId: string;
  amountPaise: number;
  paymentMethod: string;
  status: "SUCCESS" | "FAILED" | "RECOVERED";
  failureCode?: string;
  occurredAtUtc?: string;
}

export interface CredentialBehavioralMetrics {
  credentialId: string;
  totalTransactions: number;
  successCount: number;
  failureCount: number;
  lifetimeSuccessRate: number;
  velocity24hFailures: number;
  txRecencyDays: number | null;
  avgHistoricalTicketPaise: number;
  ticketZScore: number;
}

/**
 * Appends an immutable transaction record to the customer purchase ledger.
 */
export async function appendPurchaseLedger(
  dbClient: Client,
  entry: PurchaseLedgerEntry,
): Promise<string> {
  const id = entry.id || `tx_${entry.credentialId.slice(0, 8)}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const occurredAtUtc = entry.occurredAtUtc || new Date().toISOString();

  await dbClient.execute({
    sql: `INSERT INTO customer_purchase_ledger (
            id, credential_id, amount_paise, payment_method, status, failure_code, occurred_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      entry.credentialId,
      entry.amountPaise,
      entry.paymentMethod,
      entry.status,
      entry.failureCode || null,
      occurredAtUtc,
    ],
  });

  return id;
}

/**
 * Extracts PII-blind temporal behavioral features from the immutable ledger.
 */
export async function getCredentialBehavioralMetrics(
  dbClient: Client,
  credentialId: string,
  currentTicketPaise: number = 0,
  nowMs: number = Date.now(),
): Promise<CredentialBehavioralMetrics> {
  const res = await dbClient.execute({
    sql: `SELECT * FROM customer_purchase_ledger
          WHERE credential_id = ?
          ORDER BY occurred_at_utc ASC`,
    args: [credentialId],
  });

  const rows = res.rows;
  const totalTransactions = rows.length;

  if (totalTransactions === 0) {
    return {
      credentialId,
      totalTransactions: 0,
      successCount: 0,
      failureCount: 0,
      lifetimeSuccessRate: 0.5, // neutral uninformative prior
      velocity24hFailures: 0,
      txRecencyDays: null,
      avgHistoricalTicketPaise: currentTicketPaise,
      ticketZScore: 0,
    };
  }

  let successCount = 0;
  let failureCount = 0;
  let velocity24hFailures = 0;
  let lastSuccessMs: number | null = null;
  const ticketAmounts: number[] = [];

  const ms24hAgo = nowMs - 24 * 60 * 60 * 1000;

  for (const r of rows) {
    const status = String(r.status);
    const amt = Number(r.amount_paise);
    const txTimeMs = new Date(String(r.occurred_at_utc)).getTime();

    ticketAmounts.push(amt);

    if (status === "SUCCESS" || status === "RECOVERED") {
      successCount++;
      if (lastSuccessMs === null || txTimeMs > lastSuccessMs) {
        lastSuccessMs = txTimeMs;
      }
    } else if (status === "FAILED") {
      failureCount++;
      if (txTimeMs >= ms24hAgo) {
        velocity24hFailures++;
      }
    }
  }

  const lifetimeSuccessRate = totalTransactions > 0 ? Number((successCount / totalTransactions).toFixed(3)) : 0.5;

  const txRecencyDays =
    lastSuccessMs !== null ? Number(((nowMs - lastSuccessMs) / (24 * 60 * 60 * 1000)).toFixed(1)) : null;

  // Compute Mean and Standard Deviation of historical tickets
  const meanTicket = ticketAmounts.reduce((acc, x) => acc + x, 0) / ticketAmounts.length;
  const variance = ticketAmounts.reduce((acc, x) => acc + Math.pow(x - meanTicket, 2), 0) / ticketAmounts.length;
  const stdTicket = Math.sqrt(variance);

  const ticketZScore = stdTicket > 0 ? Number(((currentTicketPaise - meanTicket) / stdTicket).toFixed(2)) : 0;

  return {
    credentialId,
    totalTransactions,
    successCount,
    failureCount,
    lifetimeSuccessRate,
    velocity24hFailures,
    txRecencyDays,
    avgHistoricalTicketPaise: Math.round(meanTicket),
    ticketZScore,
  };
}
