-- Migration 0018: Credential Identity Decoupling (Task 6.5 / ID-06)
-- Decouples mutable customer display names from cryptographic SHA-256 credentials

CREATE TABLE IF NOT EXISTS customer_credentials (
  id TEXT PRIMARY KEY, -- SHA256(normalized_phone + ":" + lower_email)
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cred_phone_email ON customer_credentials(phone, email);

-- Snapshot columns on live payment events for audit trail
ALTER TABLE live_payment_events ADD COLUMN credential_id TEXT REFERENCES customer_credentials(id);
ALTER TABLE live_payment_events ADD COLUMN customer_display_name TEXT;
