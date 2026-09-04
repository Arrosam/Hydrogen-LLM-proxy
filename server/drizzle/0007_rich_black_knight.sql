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
CREATE UNIQUE INDEX `proxies_name_idx` ON `proxies` (`name`);--> statement-breakpoint
ALTER TABLE `providers` ADD `proxy_id` integer REFERENCES proxies(id);