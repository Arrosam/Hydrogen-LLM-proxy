ALTER TABLE `request_logs` ADD `cached_input_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `cache_creation_input_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `reasoning_tokens` integer DEFAULT 0 NOT NULL;