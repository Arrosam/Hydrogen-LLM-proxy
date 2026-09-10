CREATE TABLE `conversation_items` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`item_json` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `response_conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_items_id_idx` ON `conversation_items` (`conversation_id`,`id`);--> statement-breakpoint
CREATE INDEX `conversation_items_order_idx` ON `conversation_items` (`conversation_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `hosted_tools` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`config_json` text NOT NULL,
	`headers_secret` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hosted_tools_name_idx` ON `hosted_tools` (`name`);--> statement-breakpoint
CREATE TABLE `response_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`token_id` integer NOT NULL,
	`metadata_json` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL,
	`touched_at` integer NOT NULL,
	FOREIGN KEY (`token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `response_conversations_token_idx` ON `response_conversations` (`token_id`);--> statement-breakpoint
CREATE INDEX `response_conversations_touch_idx` ON `response_conversations` (`touched_at`);--> statement-breakpoint
CREATE TABLE `service_tools` (
	`service_id` integer NOT NULL,
	`tool_id` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `model_services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tool_id`) REFERENCES `hosted_tools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_tools_pair_idx` ON `service_tools` (`service_id`,`tool_id`);--> statement-breakpoint
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
	`touched_at` integer NOT NULL,
	FOREIGN KEY (`token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `model_services`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `stored_responses_token_idx` ON `stored_responses` (`token_id`);--> statement-breakpoint
CREATE INDEX `stored_responses_touch_idx` ON `stored_responses` (`touched_at`);--> statement-breakpoint
CREATE INDEX `stored_responses_status_idx` ON `stored_responses` (`status`);