-- Migration 0010: Add retry_count and outbound fields for dashboard requirements
-- retry_count tracks how many times a customer retried the same order
-- outreach_next_utc tracks when the next outreach should happen
-- outreach_channel tracks which channel (SMS/Email) was used

ALTER TABLE live_payment_events ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
-- Number of times customer retried this payment (0 = first attempt)

ALTER TABLE live_payment_events ADD COLUMN outreach_next_utc TEXT;
-- When the next outreach should happen (for AI Action column)

ALTER TABLE live_payment_events ADD COLUMN outreach_channel TEXT;
-- Which channel was used for outreach (SMS, Email)

ALTER TABLE live_payment_events ADD COLUMN last_outreach_utc TEXT;
-- When the last outreach was sent

CREATE INDEX IF NOT EXISTS idx_liveevt_retry ON live_payment_events(retry_count);
CREATE INDEX IF NOT EXISTS idx_liveevt_status ON live_payment_events(status);
CREATE INDEX IF NOT EXISTS idx_liveevt_customer ON live_payment_events(customer_profile_id);
