CREATE TABLE `game_settings` (
	`game_id` text PRIMARY KEY NOT NULL,
	`owner_timezone` text NOT NULL,
	`backup_hour` text NOT NULL,
	`backup_timezone` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
DROP INDEX `idx_versions_game_hash`;--> statement-breakpoint
CREATE INDEX `idx_versions_game_hash` ON `versions` (`game_id`,`content_hash`);