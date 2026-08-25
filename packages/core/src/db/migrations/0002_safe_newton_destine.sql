ALTER TABLE `customers` ADD `payday_true_day` integer;--> statement-breakpoint
ALTER TABLE `customers` ADD `prior_success_count` integer DEFAULT 0 NOT NULL;