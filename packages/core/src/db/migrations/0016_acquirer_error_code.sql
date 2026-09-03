-- Migration 0016: Add acquirer_error_code to live_payment_events
ALTER TABLE live_payment_events ADD COLUMN acquirer_error_code TEXT;
