-- A verified database backup must be completed before applying this migration.
-- `legacy_status` makes the mapping reversible without discarding provenance.
ALTER TABLE `tasks` ADD COLUMN `lifecycle` text NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `outcome` text;
--> statement-breakpoint
-- SQLite ALTER TABLE only permits constant defaults; existing rows are populated below
-- and all application writes maintain this field.
ALTER TABLE `tasks` ADD COLUMN `workflow_changed_at` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `revision` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `legacy_status` text;
--> statement-breakpoint
UPDATE `tasks`
SET `legacy_status` = `status`,
    `lifecycle` = CASE WHEN `status` = 'archived' THEN 'archived' ELSE 'active' END,
    `outcome` = NULL,
    `workflow_changed_at` = COALESCE(`updated_at`, CURRENT_TIMESTAMP);
--> statement-breakpoint
-- Defense in depth for all current and future transports: an archive racing an
-- assignment write cannot create a new active assignment after the archive.
CREATE TRIGGER `assignments_reject_archived_insert`
BEFORE INSERT ON `assignments`
WHEN (SELECT `lifecycle` FROM `tasks` WHERE `id` = NEW.`task_id`) = 'archived'
BEGIN
  SELECT RAISE(ABORT, 'TASK_ARCHIVED');
END;
--> statement-breakpoint
CREATE TRIGGER `assignments_reject_archived_update`
BEFORE UPDATE ON `assignments`
WHEN (SELECT `lifecycle` FROM `tasks` WHERE `id` = NEW.`task_id`) = 'archived'
BEGIN
  SELECT RAISE(ABORT, 'TASK_ARCHIVED');
END;
--> statement-breakpoint
CREATE UNIQUE INDEX `assignments_one_primary_per_task`
ON `assignments` (`task_id`) WHERE `focus` = 'primary';
