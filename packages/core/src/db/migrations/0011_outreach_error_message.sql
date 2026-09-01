-- Migration 0011: Add error_message to scheduled_outreach for tracking outreach failures
-- This enables the AI Action column to show actual outreach status and errors

ALTER TABLE scheduled_outreach ADD COLUMN error_message TEXT;
