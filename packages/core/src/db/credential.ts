/**
 * Credential-Bound Identity Engine (Task 6.5 / ID-06)
 *
 * Implements DPDP Act 2023 compliant identity decoupling.
 * Mutable transaction display names are decoupled from cryptographic SHA-256
 * behavioral credential identifiers.
 */
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { normalizeIndianPhone } from "../messaging/providers/msg91.js";

/**
 * Computes deterministic SHA-256 credential ID from normalized phone and email.
 */
export function computeCredentialId(phone: string, email: string): string {
  const cleanPhone = normalizeIndianPhone(phone);
  const cleanEmail = (email || "").trim().toLowerCase();
  return createHash("sha256")
    .update(`${cleanPhone}:${cleanEmail}`)
    .digest("hex");
}

/**
 * Resolves or creates a credential record in the database.
 * Returns the immutable credential ID.
 */
export async function resolveOrCreateCredential(
  dbClient: Client,
  phone: string,
  email: string,
): Promise<string> {
  const credId = computeCredentialId(phone, email);
  const cleanPhone = normalizeIndianPhone(phone);
  const cleanEmail = (email || "").trim().toLowerCase();

  await dbClient.execute({
    sql: `INSERT INTO customer_credentials (id, phone, email, created_at_utc)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(id) DO NOTHING`,
    args: [credId, cleanPhone, cleanEmail],
  });

  return credId;
}
