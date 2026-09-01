-- Migration 0012: Snapshot customer name per transaction
-- Each payment event must store the customer name at the time of the transaction,
-- not derive it from the shared mutable customer_profiles table.

ALTER TABLE live_payment_events ADD COLUMN customer_name TEXT;
ALTER TABLE live_payment_events ADD COLUMN customer_phone TEXT;
ALTER TABLE live_payment_events ADD COLUMN customer_email TEXT;
