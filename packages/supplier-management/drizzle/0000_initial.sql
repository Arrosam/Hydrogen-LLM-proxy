CREATE TABLE `model_providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model_id` integer NOT NULL,
	`provider_id` integer NOT NULL,
	`upstream_model` text NOT NULL,
	`families` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_providers_pair_idx` ON `model_providers` (`model_id`,`provider_id`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `models_name_idx` ON `models` (`name`);--> statement-breakpoint
CREATE TABLE `provider_available_models` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` integer NOT NULL,
	`model_id` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_available_models_pair_idx` ON `provider_available_models` (`provider_id`,`model_id`);--> statement-breakpoint
CREATE INDEX `provider_available_models_provider_idx` ON `provider_available_models` (`provider_id`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`base_url` text NOT NULL,
	`key_ciphertext` text,
	`key_iv` text,
	`key_tag` text,
	`extra_headers` text,
	`alt_endpoints` text,
	`max_output_tokens` integer,
	`proxy_id` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL,
	FOREIGN KEY (`proxy_id`) REFERENCES `proxies`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `providers_name_idx` ON `providers` (`name`);--> statement-breakpoint
CREATE TABLE `proxies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`scheme` text DEFAULT 'http' NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`username` text,
	`password_ciphertext` text,
	`password_iv` text,
	`password_tag` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proxies_name_idx` ON `proxies` (`name`);