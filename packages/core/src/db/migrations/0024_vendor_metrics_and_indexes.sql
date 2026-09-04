-- Migration 0024: Atomic Metrics Rollup Summary Table & Composite Query Indexes
-- Supports O(1) vendor dashboard analytics without scanning historical rows
-- Adds composite indexes for fast keyset pagination and alert queries

CREATE TABLE IF NOT EXISTS vendor_metrics_summary (
  id TEXT PRIMARY KEY,
  total_events INTEGER NOT NULL DEFAULT 0,
  total_successes INTEGER NOT NULL DEFAULT 0,
  total_failures INTEGER NOT NULL DEFAULT 0,
  recovered_paise INTEGER NOT NULL DEFAULT 0,
  at_risk_paise INTEGER NOT NULL DEFAULT 0,
  method_card INTEGER NOT NULL DEFAULT 0,
  method_upi INTEGER NOT NULL DEFAULT 0,
  method_netbanking INTEGER NOT NULL DEFAULT 0,
  method_wallet INTEGER NOT NULL DEFAULT 0,
  method_other INTEGER NOT NULL DEFAULT 0,
  updated_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lpe_cust_created ON live_payment_events(customer_profile_id, created_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_lpe_alerts ON live_payment_events(vendor_notified, vendor_decision, created_at_utc DESC);
