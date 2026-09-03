-- Migration 0017: Multi-Domain Expansion for Track 3 (SaaS Mandates, Abandoned Checkouts, B2B Invoices)

-- 1. SaaS Recurring Subscription Mandates (UPI Autopay, eNACH)
CREATE TABLE IF NOT EXISTS subscription_mandates (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  customer_name TEXT,
  customer_phone TEXT,
  customer_email TEXT,
  mandate_type TEXT NOT NULL, -- 'UPI_AUTOPAY', 'E_NACH', 'CARD_RECURRING'
  plan_name TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  last_failure_code TEXT,
  next_retry_at_utc TEXT,
  pre_debit_notified_at_utc TEXT,
  retry_sequence_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  status TEXT DEFAULT 'ACTIVE', -- 'ACTIVE', 'RECOVERED', 'CANCELLED', 'SOFT_LOCK'
  created_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mandates_customer ON subscription_mandates(customer_id);
CREATE INDEX IF NOT EXISTS idx_mandates_status ON subscription_mandates(status);

-- 2. Abandoned Pre-Payment Checkouts (Magic Checkout)
CREATE TABLE IF NOT EXISTS abandoned_checkouts (
  id TEXT PRIMARY KEY,
  customer_name TEXT,
  customer_phone TEXT NOT NULL,
  customer_email TEXT,
  cart_items_json TEXT,
  cart_amount_paise INTEGER NOT NULL,
  drop_off_step TEXT NOT NULL, -- 'PHONE_ENTERED', 'ADDRESS_SUBMITTED', 'PAYMENT_SCREEN_EXITED'
  recovery_token TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'ABANDONED', -- 'ABANDONED', 'SALVAGED', 'EXPIRED'
  created_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_checkouts_token ON abandoned_checkouts(recovery_token);
CREATE INDEX IF NOT EXISTS idx_checkouts_phone ON abandoned_checkouts(customer_phone);

-- 3. B2B Corporate Invoices & Receivables (Net 30 terms)
CREATE TABLE IF NOT EXISTS b2b_invoices (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL,
  client_company TEXT NOT NULL,
  contact_person TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  contact_phone TEXT,
  amount_paise INTEGER NOT NULL,
  invoice_number TEXT UNIQUE NOT NULL,
  due_date_utc TEXT NOT NULL,
  days_overdue INTEGER DEFAULT 0,
  early_discount_percent REAL DEFAULT 2.0, -- '2/10 Net 30'
  virtual_vpa TEXT,
  status TEXT DEFAULT 'OVERDUE', -- 'OVERDUE', 'PAID', 'DISCOUNT_APPLIED'
  created_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invoices_vendor ON b2b_invoices(vendor_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON b2b_invoices(status);
