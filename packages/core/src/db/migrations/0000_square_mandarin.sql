CREATE TABLE `actions` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`executor` text NOT NULL,
	`payload_json` text NOT NULL,
	`rzp_request_ref` text,
	`outcome` text DEFAULT 'PENDING' NOT NULL,
	`executed_at_utc` text,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_actions_idem` ON `actions` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `approval_records` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` text NOT NULL,
	`actor` text NOT NULL,
	`decision` text NOT NULL,
	`note` text,
	`decided_at_utc` text NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts_utc` text NOT NULL,
	`tenant_id` text NOT NULL,
	`event_id` text,
	`actor` text NOT NULL,
	`entry_type` text NOT NULL,
	`payload_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_event` ON `audit_log` (`event_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_type` ON `audit_log` (`entry_type`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`pseudo_name` text NOT NULL,
	`phone_fake` text NOT NULL,
	`email_fake` text NOT NULL,
	`payday_pattern_json` text DEFAULT '{}' NOT NULL,
	`channel_responsiveness` real DEFAULT 0.5 NOT NULL,
	`opted_out` integer DEFAULT false NOT NULL,
	`joined_at_utc` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_customers_tenant` ON `customers` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `drift_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`window_start_utc` text NOT NULL,
	`window_end_utc` text NOT NULL,
	`sample_size` integer NOT NULL,
	`predicted_rate` real NOT NULL,
	`realized_rate` real NOT NULL,
	`verdict` text NOT NULL,
	`envelope_before_json` text NOT NULL,
	`envelope_after_json` text NOT NULL,
	`checked_at_utc` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `features` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`feature_version` text NOT NULL,
	`vector_json` text NOT NULL,
	`computed_at_utc` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `payment_events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_features_event_version` ON `features` (`event_id`,`feature_version`);--> statement-breakpoint
CREATE TABLE `job_locks` (
	`name` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`acquired_at_utc` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `metrics_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`corpus_sha` text NOT NULL,
	`arm` text NOT NULL,
	`mc_iteration` integer NOT NULL,
	`recovered_paise` integer NOT NULL,
	`contacts_made` integer NOT NULL,
	`wasted_attempts` integer NOT NULL,
	`policy_refusals` integer NOT NULL,
	`params_json` text NOT NULL,
	`ran_at_utc` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `model_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'logreg' NOT NULL,
	`weights_json` text NOT NULL,
	`weights_sha256` text NOT NULL,
	`dataset_sha256` text NOT NULL,
	`feature_names_json` text NOT NULL,
	`metrics_json` text NOT NULL,
	`trained_at_utc` text NOT NULL,
	`status` text DEFAULT 'CANDIDATE' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`customer_id` text NOT NULL,
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
CREATE INDEX `idx_events_customer` ON `payment_events` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_events_tenant_time` ON `payment_events` (`tenant_id`,`occurred_at_utc`);--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`model_version_id` text NOT NULL,
	`policy_version` text NOT NULL,
	`action_json` text NOT NULL,
	`ev_paise` integer NOT NULL,
	`confidence` real NOT NULL,
	`attributions_json` text DEFAULT '[]' NOT NULL,
	`narrative` text,
	`state` text DEFAULT 'PROPOSED' NOT NULL,
	`state_version` integer DEFAULT 0 NOT NULL,
	`dedupe_key` text NOT NULL,
	`feature_version` text DEFAULT 'feat-v1' NOT NULL,
	`created_at_utc` text NOT NULL,
	`updated_at_utc` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `payment_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_version_id`) REFERENCES `model_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_proposals_dedupe` ON `proposals` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_proposals_state_ev` ON `proposals` (`state`,`ev_paise`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_one_open_per_customer` ON `proposals` (`customer_id`,`event_id`) WHERE 
      state IN ('PROPOSED','AWAITING_APPROVAL','AUTO_APPROVED','APPROVED','EXECUTING')
    ;--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`autonomy_envelope_json` text DEFAULT '{}' NOT NULL,
	`policy_version` text DEFAULT 'v1' NOT NULL,
	`created_at_utc` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webhook_dedupe` (
	`provider_event_id` text PRIMARY KEY NOT NULL,
	`first_seen_utc` text NOT NULL,
	`swallow_count` integer DEFAULT 0 NOT NULL
);
