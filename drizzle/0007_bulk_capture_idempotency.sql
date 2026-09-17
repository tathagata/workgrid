-- Back up the database before applying release migrations.
-- Records completed bulk-capture submissions so a retried request with the
-- same idempotency key returns the original result instead of duplicating tasks.
CREATE TABLE `idempotency_keys` (
  `key` text PRIMARY KEY NOT NULL,
  `task_ids` text NOT NULL,
  `revision` integer NOT NULL,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
