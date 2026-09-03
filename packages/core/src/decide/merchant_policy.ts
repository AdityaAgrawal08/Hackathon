/**
 * Merchant Recovery Policy Engine (Task 6.7 / POL-08)
 *
 * Governs product-level recovery parameters:
 * - Split-Pay allowances & minimum ticket sizes
 * - Grace periods before account hold / soft-lock
 * - Split markup percentages
 */
import type { Client } from "@libsql/client";

export interface MerchantRecoveryPolicy {
  id?: string;
  productId: string;
  allowSplitRecovery: boolean;
  minSplitTicketPaise: number;
  splitInstallments: number;
  splitMarkupBps: number;
  gracePeriodDays: number;
  expiryAction: "SOFT_LOCK_FREE_TIER" | "CANCEL_ORDER" | "HALT_CREDIT";
  createdAtUtc?: string;
  updatedAtUtc?: string;
}

export const DEFAULT_MERCHANT_POLICY: Omit<MerchantRecoveryPolicy, "productId"> = {
  allowSplitRecovery: true,
  minSplitTicketPaise: 199900, // ₹1,999
  splitInstallments: 3,
  splitMarkupBps: 0,
  gracePeriodDays: 3,
  expiryAction: "SOFT_LOCK_FREE_TIER",
};

/**
 * Retrieves the recovery policy for a given product ID, falling back to defaults if unconfigured.
 */
export async function getMerchantPolicy(
  dbClient: Client,
  productId: string,
): Promise<MerchantRecoveryPolicy> {
  const res = await dbClient.execute({
    sql: `SELECT * FROM merchant_recovery_policies WHERE product_id = ?`,
    args: [productId],
  });

  if (res.rows.length === 0) {
    return {
      productId,
      ...DEFAULT_MERCHANT_POLICY,
    };
  }

  const row = res.rows[0];
  if (!row) {
    return {
      productId,
      ...DEFAULT_MERCHANT_POLICY,
    };
  }
  return {
    id: String(row.id),
    productId: String(row.product_id),
    allowSplitRecovery: Number(row.allow_split_recovery) === 1,
    minSplitTicketPaise: Number(row.min_split_ticket_paise),
    splitInstallments: Number(row.split_installments),
    splitMarkupBps: Number(row.split_markup_bps),
    gracePeriodDays: Number(row.grace_period_days),
    expiryAction: String(row.expiry_action) as any,
    createdAtUtc: String(row.created_at_utc),
    updatedAtUtc: String(row.updated_at_utc),
  };
}

/**
 * Upserts a merchant recovery policy for a product.
 */
export async function upsertMerchantPolicy(
  dbClient: Client,
  policy: MerchantRecoveryPolicy,
): Promise<MerchantRecoveryPolicy> {
  const id = policy.id || `pol_${policy.productId}`;
  const nowUtc = new Date().toISOString();

  await dbClient.execute({
    sql: `INSERT INTO merchant_recovery_policies (
            id, product_id, allow_split_recovery, min_split_ticket_paise,
            split_installments, split_markup_bps, grace_period_days, expiry_action,
            created_at_utc, updated_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(product_id) DO UPDATE SET
            allow_split_recovery = excluded.allow_split_recovery,
            min_split_ticket_paise = excluded.min_split_ticket_paise,
            split_installments = excluded.split_installments,
            split_markup_bps = excluded.split_markup_bps,
            grace_period_days = excluded.grace_period_days,
            expiry_action = excluded.expiry_action,
            updated_at_utc = excluded.updated_at_utc`,
    args: [
      id,
      policy.productId,
      policy.allowSplitRecovery ? 1 : 0,
      policy.minSplitTicketPaise,
      policy.splitInstallments,
      policy.splitMarkupBps,
      policy.gracePeriodDays,
      policy.expiryAction,
      nowUtc,
      nowUtc,
    ],
  });

  return getMerchantPolicy(dbClient, policy.productId);
}
