-- Migration 0019: Merchant Recovery Policy Engine (Task 6.7 / POL-08)

CREATE TABLE IF NOT EXISTS merchant_recovery_policies (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL UNIQUE,
  allow_split_recovery INTEGER NOT NULL DEFAULT 1, -- 1=Enabled, 0=Disabled
  min_split_ticket_paise INTEGER NOT NULL DEFAULT 199900, -- ₹1,999 minimum
  split_installments INTEGER NOT NULL DEFAULT 3, -- 2 or 3 installments
  split_markup_bps INTEGER NOT NULL DEFAULT 0, -- e.g. 500 = 5% markup
  grace_period_days INTEGER NOT NULL DEFAULT 3, -- Grace period before soft lock
  expiry_action TEXT NOT NULL DEFAULT 'SOFT_LOCK_FREE_TIER', -- 'SOFT_LOCK_FREE_TIER', 'CANCEL_ORDER', 'HALT_CREDIT'
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);
