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
CREATE TABLE `service_tools` (
	`service_id` integer NOT NULL,
	`tool_id` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `model_services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tool_id`) REFERENCES `hosted_tools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_tools_pair_idx` ON `service_tools` (`service_id`,`tool_id`);