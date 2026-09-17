import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contracts = await readFile(new URL("../lib/domain/contracts.ts", import.meta.url), "utf8");
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0001_task_workflow.sql", import.meta.url), "utf8");

test("transport exposes versioned workflow DTO and explicit commands", () => {
  assert.match(contracts, /API_VERSION = 1/);
  assert.match(contracts, /action: z\.literal\("archiveTask"\)/);
  assert.match(contracts, /action: z\.literal\("restoreTask"\)/);
  assert.doesNotMatch(contracts, /setTaskStatus/);
});

test("migration retains source state and all assignment records", () => {
  assert.match(migration, /legacy_status/);
  assert.match(migration, /WHEN `status` = 'archived' THEN 'archived' ELSE 'active'/);
  assert.doesNotMatch(migration, /DELETE FROM/);
  assert.doesNotMatch(migration, /DROP TABLE/);
  assert.match(migration, /assignments_reject_archived_insert/);
  assert.match(migration, /assignments_reject_archived_update/);
  assert.match(migration, /assignments_one_primary_per_task/);
});

test("UI offers three accessible lifecycle views and explicit terminal actions", () => {
  for (const label of ["Unfocused", "Focused", "Archived", "Mark completed", "Restore to active work"]) assert.match(page, new RegExp(label));
  assert.match(page, /expectedRevision: task\.revision/);
  assert.doesNotMatch(page, /Put on hold/);
});
