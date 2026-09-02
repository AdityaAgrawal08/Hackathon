-- Migration 0013: Recovery portal, promise-to-pay, downsell tracking, and audit ledger

CREATE TABLE IF NOT EXISTS audit_ledger (
  id TEXT PRIMARY KEY NOT NULL,
  event_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  customer_id TEXT,
  actor TEXT NOT NULL DEFAULT 'system',
  payload_json TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT NOT NULL DEFAULT 'GENESIS',
  entry_hash TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_ledger(entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_ledger(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_ledger(created_at_utc);

CREATE TABLE IF NOT EXISTS live_promise_to_pay (
  id TEXT PRIMARY KEY NOT NULL,
  live_payment_event_id TEXT NOT NULL,
  customer_profile_id TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  promised_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'FULFILLED', 'EXPIRED', 'CANCELLED')),
  reminder_scheduled_utc TEXT,
  created_at_utc TEXT NOT NULL,
  resolved_at_utc TEXT
);

CREATE INDEX IF NOT EXISTS idx_livepromise_event ON live_promise_to_pay(live_payment_event_id);
CREATE INDEX IF NOT EXISTS idx_livepromise_cust ON live_promise_to_pay(customer_profile_id);
CREATE INDEX IF NOT EXISTS idx_livepromise_status ON live_promise_to_pay(status);

CREATE TABLE IF NOT EXISTS downsell_offers (
  id TEXT PRIMARY KEY NOT NULL,
  parent_event_id TEXT NOT NULL,
  customer_profile_id TEXT NOT NULL,
  downsell_type TEXT NOT NULL CHECK(downsell_type IN ('split_3', 'switch_monthly', 'custom')),
  original_amount_paise INTEGER NOT NULL,
  downsell_amount_paise INTEGER NOT NULL,
  razorpay_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'OFFERED' CHECK(status IN ('OFFERED', 'ACCEPTED', 'PAID', 'EXPIRED')),
  created_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_downsell_parent ON downsell_offers(parent_event_id);
CREATE INDEX IF NOT EXISTS idx_downsell_order ON downsell_offers(razorpay_order_id);

CREATE TABLE IF NOT EXISTS scheduled_outreach_new (
  id TEXT PRIMARY KEY,
  live_payment_event_id TEXT NOT NULL REFERENCES live_payment_events(id),
  customer_profile_id TEXT NOT NULL REFERENCES customer_profiles(id),
  channel TEXT NOT NULL CHECK(channel IN ('EMAIL', 'SMS')),
  scheduled_at_utc TEXT NOT NULL,
  executed INTEGER NOT NULL DEFAULT 0,
  executed_at_utc TEXT,
  status TEXT CHECK(status IN ('SENT', 'FAILED', 'SUPPRESSED', 'PENDING', 'CANCELLED')),
  error_message TEXT,
  cancelled_reason TEXT,
  cancelled_at_utc TEXT
);

INSERT OR IGNORE INTO scheduled_outreach_new (id, live_payment_event_id, customer_profile_id, channel, scheduled_at_utc, executed, executed_at_utc, status, error_message)
SELECT id, live_payment_event_id, customer_profile_id, channel, scheduled_at_utc, executed, executed_at_utc, status, error_message FROM scheduled_outreach;

DROP TABLE IF EXISTS scheduled_outreach;
ALTER TABLE scheduled_outreach_new RENAME TO scheduled_outreach;

CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_outreach(executed, scheduled_at_utc);
CREATE INDEX IF NOT EXISTS idx_scheduled_event ON scheduled_outreach(live_payment_event_id);
