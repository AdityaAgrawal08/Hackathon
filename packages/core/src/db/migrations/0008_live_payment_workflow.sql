-- Migration 0008: Live payment workflow tables
-- Adds customer_profiles, live_payment_events, scheduled_outreach

CREATE TABLE IF NOT EXISTS customer_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  total_attempts INTEGER NOT NULL DEFAULT 0,
  total_successes INTEGER NOT NULL DEFAULT 0,
  total_failures INTEGER NOT NULL DEFAULT 0,
  last_failure_code TEXT,
  last_failure_at_utc TEXT,
  flagged_as_suspicious INTEGER NOT NULL DEFAULT 0,
  vendor_decision TEXT CHECK(vendor_decision IN ('approved', 'rejected')),
  risk_score_bp INTEGER NOT NULL DEFAULT 0,
  total_amount_paise INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_custprofile_phone ON customer_profiles(phone);
CREATE INDEX IF NOT EXISTS idx_custprofile_suspicious ON customer_profiles(flagged_as_suspicious);

CREATE TABLE IF NOT EXISTS live_payment_events (
  id TEXT PRIMARY KEY,
  razorpay_payment_id TEXT,
  razorpay_order_id TEXT,
  customer_profile_id TEXT NOT NULL REFERENCES customer_profiles(id),
  product_name TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('authorized', 'captured', 'failed', 'refunded', 'pending')),
  failure_code TEXT,
  failure_description TEXT,
  failure_step TEXT,
  failure_source TEXT,
  failure_reason TEXT,
  failure_class TEXT CHECK(failure_class IN ('SOFT_RETRYABLE', 'HARD_METHOD_DEAD', 'NETWORK_TIMEOUT', 'RISK_FLAGGED', 'UNKNOWN')),
  ml_probability REAL,
  ml_action TEXT,
  outreach_dispatched INTEGER NOT NULL DEFAULT 0,
  vendor_notified INTEGER NOT NULL DEFAULT 0,
  vendor_decision TEXT CHECK(vendor_decision IN ('approved', 'rejected')),
  recovered_at_utc TEXT,
  created_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_liveevt_customer ON live_payment_events(customer_profile_id);
CREATE INDEX IF NOT EXISTS idx_liveevt_status ON live_payment_events(status);
CREATE INDEX IF NOT EXISTS idx_liveevt_failure_class ON live_payment_events(failure_class);
CREATE INDEX IF NOT EXISTS idx_liveevt_created ON live_payment_events(created_at_utc);
CREATE INDEX IF NOT EXISTS idx_liveevt_vendor_notified ON live_payment_events(vendor_notified);

CREATE TABLE IF NOT EXISTS scheduled_outreach (
  id TEXT PRIMARY KEY,
  live_payment_event_id TEXT NOT NULL REFERENCES live_payment_events(id),
  customer_profile_id TEXT NOT NULL REFERENCES customer_profiles(id),
  channel TEXT NOT NULL CHECK(channel IN ('EMAIL', 'SMS')),
  scheduled_at_utc TEXT NOT NULL,
  executed INTEGER NOT NULL DEFAULT 0,
  executed_at_utc TEXT,
  status TEXT CHECK(status IN ('SENT', 'FAILED', 'SUPPRESSED', 'PENDING', 'CANCELLED')),
  cancelled_reason TEXT,
  cancelled_at_utc TEXT
);

CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_outreach(executed, scheduled_at_utc);
CREATE INDEX IF NOT EXISTS idx_scheduled_event ON scheduled_outreach(live_payment_event_id);
