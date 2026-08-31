-- Migration 0009: Capture full Razorpay webhook fields
-- Adds payment method, card details, UPI, bank, acquirer data to live_payment_events
-- These fields come from the Razorpay payment.failed webhook entity

ALTER TABLE live_payment_events ADD COLUMN payment_method TEXT;
-- card, upi, netbanking, wallet, emi, netbanking

ALTER TABLE live_payment_events ADD COLUMN card_last4 TEXT;
-- Last 4 digits of card (e.g. "0153")

ALTER TABLE live_payment_events ADD COLUMN card_network TEXT;
-- Visa, Mastercard, RuPay, AMEX, Diners Club

ALTER TABLE live_payment_events ADD COLUMN card_issuer TEXT;
-- Bank that issued the card (e.g. "HDFC", "SBI")

ALTER TABLE live_payment_events ADD COLUMN card_type TEXT;
-- credit, debit

ALTER TABLE live_payment_events ADD COLUMN card_emi INTEGER;
-- 1 if EMI payment, 0 otherwise

ALTER TABLE live_payment_events ADD COLUMN vpa TEXT;
-- UPI VPA (e.g. "user@upi") — only for UPI payments

ALTER TABLE live_payment_events ADD COLUMN bank_code TEXT;
-- Bank code for netbanking (e.g. "HDFC", "KKBK")

ALTER TABLE live_payment_events ADD COLUMN is_international INTEGER NOT NULL DEFAULT 0;
-- 1 for international cards, 0 for domestic

ALTER TABLE live_payment_events ADD COLUMN acquirer_auth_code TEXT;
-- Bank authorization code from acquirer_data

ALTER TABLE live_payment_events ADD COLUMN acquirer_rrn TEXT;
-- Network Reference Number (RRN) from acquirer_data

ALTER TABLE live_payment_events ADD COLUMN razorpay_token_id TEXT;
-- Saved instrument token ID (for recurring payments)

ALTER TABLE live_payment_events ADD COLUMN razorpay_contact TEXT;
-- Customer phone from webhook (may differ from profile)

ALTER TABLE live_payment_events ADD COLUMN razorpay_email TEXT;
-- Customer email from webhook (may differ from profile)

ALTER TABLE live_payment_events ADD COLUMN razorpay_created_at INTEGER;
-- Razorpay payment created_at timestamp (epoch seconds)

CREATE INDEX IF NOT EXISTS idx_liveevt_method ON live_payment_events(payment_method);
CREATE INDEX IF NOT EXISTS idx_liveevt_card_network ON live_payment_events(card_network);
CREATE INDEX IF NOT EXISTS idx_liveevt_international ON live_payment_events(is_international);
