CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chain` text NOT NULL,
	`tx_hash` text NOT NULL,
	`log_index` integer NOT NULL,
	`emission_seq` integer DEFAULT 0 NOT NULL,
	`timestamp` integer NOT NULL,
	`wallet` text NOT NULL,
	`type` text NOT NULL,
	`subtype` text NOT NULL,
	`sent_asset` text,
	`sent_amount` blob,
	`received_asset` text,
	`received_amount` blob,
	`price_usd_json` text,
	`position_id` text,
	`flags_json` text,
	`handler_id` text NOT NULL,
	`handler_version` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_by_wallet` ON `events` (`wallet`,`timestamp`);--> statement-breakpoint
CREATE INDEX `events_by_position` ON `events` (`position_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_uq` ON `events` (`chain`,`tx_hash`,`log_index`,`emission_seq`);--> statement-breakpoint
CREATE TABLE `positions` (
	`position_id` text PRIMARY KEY NOT NULL,
	`chain` text NOT NULL,
	`protocol` text NOT NULL,
	`wallet` text NOT NULL,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`state_json` text
);
--> statement-breakpoint
CREATE TABLE `prices` (
	`asset` text NOT NULL,
	`date` text NOT NULL,
	`usd_price` real NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`asset`, `date`)
);
--> statement-breakpoint
CREATE TABLE `raw_txs` (
	`chain` text NOT NULL,
	`tx_hash` text NOT NULL,
	`block_number` integer NOT NULL,
	`block_timestamp` integer NOT NULL,
	`raw_json` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`chain`, `tx_hash`)
);
--> statement-breakpoint
CREATE TABLE `rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_json` text NOT NULL,
	`template_json` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`last_applied_at` integer,
	`applied_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transfer_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`out_event_id` integer NOT NULL,
	`in_event_id` integer NOT NULL,
	`confidence` real NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`heuristic` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `unclassified` (
	`chain` text NOT NULL,
	`tx_hash` text NOT NULL,
	`raw_json` text NOT NULL,
	`reason` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`resolved_at` integer,
	PRIMARY KEY(`chain`, `tx_hash`)
);
