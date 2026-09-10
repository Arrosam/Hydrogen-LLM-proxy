CREATE TABLE `response_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`response_id` text NOT NULL,
	`event` text NOT NULL,
	FOREIGN KEY (`response_id`) REFERENCES `stored_responses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `response_events_response_idx` ON `response_events` (`response_id`,`sequence`);