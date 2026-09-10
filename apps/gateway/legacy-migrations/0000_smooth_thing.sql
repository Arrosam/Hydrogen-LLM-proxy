CREATE TABLE `model_providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model_id` integer NOT NULL,
	`provider_id` integer NOT NULL,
	`upstream_model` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_providers_pair_idx` ON `model_providers` (`model_id`,`provider_id`);--> statement-breakpoint
CREATE TABLE `model_services` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`kind` text DEFAULT 'model_service' NOT NULL,
	`definition_json` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_name_idx` ON `model_services` (`name`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `models_name_idx` ON `models` (`name`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`base_url` text NOT NULL,
	`key_ciphertext` text,
	`key_iv` text,
	`key_tag` text,
	`extra_headers` text,
	`max_output_tokens` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `providers_name_idx` ON `providers` (`name`);--> statement-breakpoint
CREATE TABLE `request_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trace_id` text NOT NULL,
	`token_id` integer,
	`service_id` integer,
	`requested_service` text,
	`served_model` text,
	`served_provider` text,
	`ingress_format` text NOT NULL,
	`egress_format` text,
	`streaming` integer DEFAULT false NOT NULL,
	`http_status` integer NOT NULL,
	`request_method` text,
	`request_path` text,
	`request_query` text,
	`request_headers_json` text,
	`request_body` text,
	`response_headers_json` text,
	`response_body` text,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`attempt_path_json` text,
	`error` text,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL,
	FOREIGN KEY (`token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`service_id`) REFERENCES `model_services`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `request_logs_created_idx` ON `request_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `request_logs_trace_idx` ON `request_logs` (`trace_id`);--> statement-breakpoint
CREATE INDEX `request_logs_token_idx` ON `request_logs` (`token_id`);--> statement-breakpoint
CREATE INDEX `request_logs_service_idx` ON `request_logs` (`service_id`);--> statement-breakpoint
CREATE INDEX `request_logs_requested_idx` ON `request_logs` (`requested_service`);--> statement-breakpoint
CREATE INDEX `request_logs_served_model_idx` ON `request_logs` (`served_model`);--> statement-breakpoint
CREATE INDEX `request_logs_served_provider_idx` ON `request_logs` (`served_provider`);--> statement-breakpoint
CREATE INDEX `request_logs_status_idx` ON `request_logs` (`http_status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`owner_user_id` integer,
	`scope_services_json` text,
	`max_requests` integer,
	`max_tokens` integer,
	`used_requests` integer DEFAULT 0 NOT NULL,
	`used_tokens` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_hash_idx` ON `tokens` (`key_hash`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'manager' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`must_change_password` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_idx` ON `users` (`username`);