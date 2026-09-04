-- Migration 0022: Customer Behavioral Memory & Merchant Domain Context Engine
-- Adds longitudinal tracking to customer_profiles (latency, responsiveness, alternate account conversion)
-- Adds merchant_domain_configs for domain-specific recovery policies (D2C, SaaS, B2B, High-Ticket)

ALTER TABLE customer_profiles ADD COLUMN preferred_channel TEXT DEFAULT 'AUTO';
ALTER TABLE customer_profiles ADD COLUMN email_open_latency_mins REAL;
ALTER TABLE customer_profiles ADD COLUMN historical_open_rate REAL NOT NULL DEFAULT 0.0;
ALTER TABLE customer_profiles ADD COLUMN historical_click_rate REAL NOT NULL DEFAULT 0.0;
ALTER TABLE customer_profiles ADD COLUMN payment_method_affinity TEXT DEFAULT 'upi';
ALTER TABLE customer_profiles ADD COLUMN ticket_sensitivity_score REAL NOT NULL DEFAULT 0.0;
ALTER TABLE customer_profiles ADD COLUMN alternate_account_converted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customer_profiles ADD COLUMN avg_recovery_latency_hours REAL;
ALTER TABLE customer_profiles ADD COLUMN total_recovered_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customer_profiles ADD COLUMN patience_score REAL NOT NULL DEFAULT 0.5;
ALTER TABLE customer_profiles ADD COLUMN last_engaged_channel TEXT;
ALTER TABLE customer_profiles ADD COLUMN last_engaged_at_utc TEXT;

CREATE TABLE IF NOT EXISTS merchant_domain_configs (
  tenant_id TEXT PRIMARY KEY,
  domain_type TEXT NOT NULL DEFAULT 'D2C_ECOMMERCE' CHECK(domain_type IN ('D2C_ECOMMERCE', 'SAAS_MANDATES', 'B2B_INVOICES', 'HIGH_TICKET')),
  cart_reservation_mins INTEGER NOT NULL DEFAULT 15,
  max_discount_concession_bp INTEGER NOT NULL DEFAULT 500,
  soft_lock_grace_days INTEGER NOT NULL DEFAULT 3,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_custprofile_channel ON customer_profiles(preferred_channel);
CREATE INDEX IF NOT EXISTS idx_custprofile_velocity ON customer_profiles(email_open_latency_mins);
