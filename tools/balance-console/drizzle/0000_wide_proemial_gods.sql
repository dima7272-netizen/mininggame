CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`user_id` text NOT NULL,
	`action` text NOT NULL,
	`entity_id` text,
	`detail_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_audit_game_created` ON `audit_logs` (`game_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `balance_goals` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`label` text NOT NULL,
	`metric` text NOT NULL,
	`target_value` text NOT NULL,
	`unit` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_goals_game` ON `balance_goals` (`game_id`);--> statement-breakpoint
CREATE TABLE `deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`version_id` text NOT NULL,
	`environment` text NOT NULL,
	`status` text NOT NULL,
	`operation_id` text NOT NULL,
	`checksum` text NOT NULL,
	`detail` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_deployments_game_started` ON `deployments` (`game_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `environment_snapshots` (
	`game_id` text NOT NULL,
	`environment` text NOT NULL,
	`version_id` text,
	`sha` text,
	`configs_json` text NOT NULL,
	`checksum` text NOT NULL,
	`verified` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`game_id`, `environment`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `game_members` (
	`game_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`permissions_json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`game_id`, `user_id`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_game_members_user` ON `game_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`default_timezone` text NOT NULL,
	`registration_open` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_games_slug` ON `games` (`slug`);--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`role` text NOT NULL,
	`permissions_json` text NOT NULL,
	`expires_at` integer NOT NULL,
	`max_uses` integer NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	`revoked_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_invitations_token` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `versions` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`base_version_id` text,
	`base_sha` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`comment` text NOT NULL,
	`configs_json` text NOT NULL,
	`validation_json` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_versions_game_created` ON `versions` (`game_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_versions_game_status` ON `versions` (`game_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_versions_game_hash` ON `versions` (`game_id`,`content_hash`);