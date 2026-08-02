CREATE TABLE `provider_available_models` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` integer NOT NULL,
	`model_id` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s','now') * 1000) NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_available_models_pair_idx` ON `provider_available_models` (`provider_id`,`model_id`);--> statement-breakpoint
CREATE INDEX `provider_available_models_provider_idx` ON `provider_available_models` (`provider_id`);