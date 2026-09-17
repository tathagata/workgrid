CREATE TABLE `board_settings` (
  `id` integer PRIMARY KEY NOT NULL CHECK (`id` = 1),
  `overfocus_threshold` real NOT NULL DEFAULT 2.5 CHECK (`overfocus_threshold` >= 0.25 AND `overfocus_threshold` <= 100)
);
--> statement-breakpoint
INSERT INTO `board_settings` (`id`, `overfocus_threshold`) VALUES (1, 2.5);
