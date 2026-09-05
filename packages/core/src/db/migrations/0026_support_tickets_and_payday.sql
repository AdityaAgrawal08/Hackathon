-- Migration 0026: Support Escalation Tickets & Customer Payday Memory
-- Supports FIX-014 and FIX-016 for real human escalation persistence and payday patterns

CREATE TABLE IF NOT EXISTS support_escalation_tickets (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'NORMAL',
  status TEXT NOT NULL DEFAULT 'OPEN',
  assigned_agent TEXT,
  created_at_utc TEXT NOT NULL,
  resolved_at_utc TEXT
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_event ON support_escalation_tickets(event_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_escalation_tickets(status);

ALTER TABLE customer_profiles ADD COLUMN inferred_payday_day INTEGER;
ALTER TABLE customer_profiles ADD COLUMN payday_confidence_bp INTEGER DEFAULT 0;
