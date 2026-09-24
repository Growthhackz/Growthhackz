CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `limits_expiry` ON `rate_limits` (`expires_at`);--> statement-breakpoint
CREATE TABLE `swap_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`wallet` text NOT NULL,
	`message` text NOT NULL,
	`quote` text NOT NULL,
	`source` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text DEFAULT 'quoted' NOT NULL,
	`signed_hash` text,
	`result` text
);
--> statement-breakpoint
CREATE INDEX `orders_created` ON `swap_orders` (`created_at`);