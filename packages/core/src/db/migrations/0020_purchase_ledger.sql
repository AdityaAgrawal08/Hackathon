-- Migration 0020: Immutable Credential-Bound Purchase Ledger (Task 6.9 / PURCH-10)

CREATE TABLE IF NOT EXISTS customer_purchase_ledger (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES customer_credentials(id),
  amount_paise INTEGER NOT NULL,
  payment_method TEXT NOT NULL,
  status TEXT NOT NULL, -- 'SUCCESS', 'FAILED', 'RECOVERED'
  failure_code TEXT,
  occurred_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_cred_time ON customer_purchase_ledger(credential_id, occurred_at_utc);
