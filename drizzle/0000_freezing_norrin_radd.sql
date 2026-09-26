CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`result_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_session_created_idx` ON `messages` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`account_set_id` text NOT NULL,
	`user_id` text NOT NULL,
	`title` text DEFAULT '新分析' NOT NULL,
	`title_manually_edited` integer DEFAULT false NOT NULL,
	`datasource_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_owner_updated_idx` ON `sessions` (`tenant_id`,`account_set_id`,`user_id`,`updated_at`);