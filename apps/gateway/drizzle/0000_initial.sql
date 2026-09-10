CREATE TABLE `conversation_items` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`item_json` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `response_conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversation_items_id_idx` ON `conversation_items` (`conversation_id`,`id`);--> statement-breakpoint
CREATE INDEX `conversation_items_order_idx` ON `conversation_items` (`conversation_id`,`sequence`);--> statement-breakpoint
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
	`upstream_request_body` text,
	`response_headers_json` text,
	`response_body` text,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_input_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`attempt_path_json` text,
	`error` text,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL
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
CREATE TABLE `response_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`token_id` integer NOT NULL,
	`metadata_json` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL,
	`touched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `response_conversations_token_idx` ON `response_conversations` (`token_id`);--> statement-breakpoint
CREATE INDEX `response_conversations_touch_idx` ON `response_conversations` (`touched_at`);--> statement-breakpoint
CREATE TABLE `response_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`response_id` text NOT NULL,
	`event` text NOT NULL,
	FOREIGN KEY (`response_id`) REFERENCES `stored_responses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `response_events_response_idx` ON `response_events` (`response_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stored_responses` (
	`id` text PRIMARY KEY NOT NULL,
	`token_id` integer NOT NULL,
	`service_id` integer,
	`previous_response_id` text,
	`conversation_id` text,
	`status` text NOT NULL,
	`background` integer DEFAULT false NOT NULL,
	`response_json` text NOT NULL,
	`input_items_json` text NOT NULL,
	`history_json` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL,
	`touched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stored_responses_token_idx` ON `stored_responses` (`token_id`);--> statement-breakpoint
CREATE INDEX `stored_responses_touch_idx` ON `stored_responses` (`touched_at`);--> statement-breakpoint
CREATE INDEX `stored_responses_status_idx` ON `stored_responses` (`status`);