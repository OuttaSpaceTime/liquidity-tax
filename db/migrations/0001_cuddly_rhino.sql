CREATE INDEX `transfer_links_by_out_event` ON `transfer_links` (`out_event_id`);--> statement-breakpoint
CREATE INDEX `transfer_links_by_in_event` ON `transfer_links` (`in_event_id`);