PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `promise_to_pay` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`event_id` text NOT NULL REFERENCES `payment_events`(`id`) ON UPDATE no action ON DELETE no action,
	`amount_paise` integer NOT NULL,
	`promised_at_utc` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`resolved_at_utc` text,
	`created_at_utc` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_id`) REFERENCES `payment_events`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `idx_promise_customer` ON `promise_to_pay` (`customer_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
