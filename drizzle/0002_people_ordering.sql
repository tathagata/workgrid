CREATE TABLE IF NOT EXISTS `board_metadata` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	CHECK (`id` = 1),
	CHECK (`revision` > 0)
);
--> statement-breakpoint
INSERT OR IGNORE INTO `board_metadata` (`id`, `revision`) VALUES (1, 1);
--> statement-breakpoint
WITH `canonical_order` AS (
	SELECT `id`, ROW_NUMBER() OVER (ORDER BY `sort_order`, `created_at`, `id`) - 1 AS `position`
	FROM `people`
)
UPDATE `people`
SET `sort_order` = (SELECT `position` FROM `canonical_order` WHERE `canonical_order`.`id` = `people`.`id`);
