ALTER TABLE `chat_members` ADD `muted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `link_preview` text;