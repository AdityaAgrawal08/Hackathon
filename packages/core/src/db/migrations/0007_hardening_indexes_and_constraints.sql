PRAGMA foreign_keys=OFF;--> statement-breakpoint
ALTER TABLE `payment_intents` ADD COLUMN `order_id` text;--> statement-breakpoint
ALTER TABLE `payment_intents` ADD COLUMN `checkout_token` text;--> statement-breakpoint
ALTER TABLE `payment_intents` ADD COLUMN `worker_claim_id` text;--> statement-breakpoint
ALTER TABLE `payment_intents` ADD COLUMN `claimed_at_utc` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_checkout_expires` ON `checkout_sessions` (`expires_at_utc`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_attempt_idem` ON `payment_attempts` (`client_idem_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_intent_order` ON `payment_intents` (`order_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_intent_status` ON `payment_intents` (`status`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
