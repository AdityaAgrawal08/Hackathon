PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `checkout_sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`order_id` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`payment_mode` text DEFAULT 'LOCAL_SANDBOX' NOT NULL,
	`expires_at_utc` text NOT NULL,
	`revoked_at_utc` text,
	`created_at_utc` text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_checkout_order` ON `checkout_sessions` (`order_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `payment_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_intent_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`client_idem_key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`attempt_number` integer NOT NULL DEFAULT 1,
	`status` text NOT NULL DEFAULT 'PENDING',
	`scenario` text,
	`provider_payment_id` text,
	`started_at_utc` text NOT NULL,
	`completed_at_utc` text
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_attempt_tenant_idem` ON `payment_attempts` (`tenant_id`, `client_idem_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_attempt_intent` ON `payment_attempts` (`payment_intent_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `provider_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_order_id` text NOT NULL,
	`provider` text NOT NULL,
	`status` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`error_code` text,
	`error_description` text,
	`captured_at_utc` text,
	`created_at_utc` text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_provider_order` ON `provider_payments` (`provider_order_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `local_settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_intent_id` text NOT NULL,
	`idem_key` text NOT NULL,
	`provider_payment_id` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`currency` text DEFAULT 'INR' NOT NULL,
	`settled_at_utc` text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_settlement_intent` ON `local_settlements` (`payment_intent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_settlement_idem` ON `local_settlements` (`idem_key`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `inbox_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`received_at_utc` text NOT NULL,
	`processed_at_utc` text
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_inbox_status` ON `inbox_events` (`status`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
