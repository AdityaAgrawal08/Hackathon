PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_payment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`customer_id` text,
	`rzp_payment_id` text,
	`subscription_id` text,
	`amount_paise` integer NOT NULL,
	`failure_code` text NOT NULL,
	`failure_class_hint` text,
	`source` text NOT NULL,
	`true_outcome_seed` real,
	`occurred_at_utc` text NOT NULL,
	`ingested_at_utc` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_payment_events`("id", "tenant_id", "customer_id", "rzp_payment_id", "subscription_id", "amount_paise", "failure_code", "failure_class_hint", "source", "true_outcome_seed", "occurred_at_utc", "ingested_at_utc") SELECT "id", "tenant_id", "customer_id", "rzp_payment_id", "subscription_id", "amount_paise", "failure_code", "failure_class_hint", "source", "true_outcome_seed", "occurred_at_utc", "ingested_at_utc" FROM `payment_events`;--> statement-breakpoint
DROP TABLE `payment_events`;--> statement-breakpoint
ALTER TABLE `__new_payment_events` RENAME TO `payment_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_events_customer` ON `payment_events` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_events_tenant_time` ON `payment_events` (`tenant_id`,`occurred_at_utc`);