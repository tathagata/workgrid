-- Back up the database before applying release migrations.
ALTER TABLE `tasks` ADD COLUMN `sort_order` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Preserve every task while assigning a stable canonical order inside each
-- public workflow list. Focused is derived from active + a primary assignment.
WITH `ranked` AS (
  SELECT t.id,
    ROW_NUMBER() OVER (
      PARTITION BY CASE
        WHEN t.lifecycle = 'archived' THEN 'archived'
        WHEN EXISTS (SELECT 1 FROM assignments a WHERE a.task_id = t.id AND a.focus = 'primary') THEN 'focused'
        ELSE 'unfocused'
      END
      ORDER BY t.updated_at DESC, t.created_at, t.id
    ) - 1 AS position
  FROM tasks t
)
UPDATE tasks SET sort_order = (SELECT position FROM ranked WHERE ranked.id = tasks.id);
--> statement-breakpoint
CREATE INDEX `tasks_workflow_order_idx` ON `tasks` (`lifecycle`, `sort_order`, `created_at`, `id`);
