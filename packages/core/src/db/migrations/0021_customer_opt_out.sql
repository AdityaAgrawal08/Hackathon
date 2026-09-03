-- Migration 0021: Customer opt-out status for WhatsApp and SMS anti-fatigue (Task 7.5 / WHA-20)
ALTER TABLE customer_profiles ADD COLUMN opted_out INTEGER NOT NULL DEFAULT 0;
