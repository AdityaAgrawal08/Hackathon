PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `payment_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`client_idem_key` text NOT NULL,
	`proposal_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`status` text DEFAULT 'PROCESSING' NOT NULL,
	`charge_id` text,
	`client_visible` text DEFAULT 'UNKNOWN' NOT NULL,
	`scenario` text,
	`created_at_utc` text NOT NULL,
	`resolved_at_utc` text,
	CONSTRAINT `payment_intents_status` CHECK (`status` IN ('PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN')),
	CONSTRAINT `payment_intents_client_visible` CHECK (`client_visible` IN ('SUCCEEDED', 'FAILED', 'UNKNOWN', 'ALREADY_SUBMITTED', 'CANCELLED', 'PROCESSING'))
);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_payment_intents_client_idem_key` ON `payment_intents` (`client_idem_key`);--> statement-breakpoint
CREATE INDEX `idx_intent_customer` ON `payment_intents` (`customer_id`);--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`idem_key` text NOT NULL,
	`kind` text NOT NULL,
	`amount_paise` integer NOT NULL,
	`balance_after_paise` integer NOT NULL,
	`at_utc` text NOT NULL,
	CONSTRAINT `ledger_entries_kind` CHECK (`kind` IN ('DEBIT', 'CREDIT', 'HOLD'))
);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ledger_idem` ON `ledger_entries` (`idem_key`, `kind`);--> statement-breakpoint
CREATE INDEX `idx_ledger_customer` ON `ledger_entries` (`customer_id`);--> statement-breakpoint
CREATE TABLE `account_balances` (
	`customer_id` text PRIMARY KEY NOT NULL,
	`balance_paise` integer NOT NULL DEFAULT 0,
	`updated_at_utc` text NOT NULL
);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`channel` text NOT NULL,
	`scenario` text,
	`message` text NOT NULL,
	`at_utc` text NOT NULL,
	`delivered` integer DEFAULT 1 NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_notif_customer` ON `notifications` (`customer_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
