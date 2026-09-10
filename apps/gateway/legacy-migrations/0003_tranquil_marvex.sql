CREATE TABLE `image_cache` (
	`hash` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `image_cache_last_used_idx` ON `image_cache` (`last_used_at`);