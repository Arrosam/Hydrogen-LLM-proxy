CREATE TABLE `tools` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'freeform' NOT NULL,
	`description` text,
	`parameters_json` text,
	`endpoint_url` text NOT NULL,
	`headers_ciphertext` text,
	`headers_iv` text,
	`headers_tag` text,
	`policy` text DEFAULT 'prefer_provider' NOT NULL,
	`max_uses` integer DEFAULT 8 NOT NULL,
	`timeout_ms` integer DEFAULT 30000 NOT NULL,
	`proxy_id` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL,
	FOREIGN KEY (`proxy_id`) REFERENCES `proxies`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tools_name_kind_idx` ON `tools` (`name`,`kind`);--> statement-breakpoint
ALTER TABLE `model_providers` ADD `tool_capabilities` text;--> statement-breakpoint
ALTER TABLE `providers` ADD `tool_capabilities` text;--> statement-breakpoint
ALTER TABLE `tokens` ADD `scope_tools_json` text;