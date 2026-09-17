import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migration = await readFile(new URL("../drizzle/0001_task_workflow.sql", import.meta.url), "utf8");

test("legacy workflow migration preserves every task and assignment", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE tasks (id text PRIMARY KEY, status text NOT NULL, updated_at text NOT NULL);
    CREATE TABLE assignments (id text PRIMARY KEY, task_id text NOT NULL, person_id text NOT NULL, focus text NOT NULL, created_at text NOT NULL, UNIQUE(task_id, person_id));
    INSERT INTO tasks VALUES ('active-owner', 'active', '2026-01-01'), ('active-none', 'active', '2026-01-02'), ('held', 'hold', '2026-01-03'), ('archived', 'archived', '2026-01-04');
    INSERT INTO assignments VALUES ('a1', 'active-owner', 'p1', 'primary', '2026-01-01'), ('a2', 'held', 'p2', 'secondary', '2026-01-03'), ('a3', 'archived', 'p3', 'primary', '2026-01-04');
  `);
  for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) db.exec(statement);

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM assignments").get().count, 3);
  const migrated = db.prepare("SELECT id, lifecycle, legacy_status AS legacyStatus FROM tasks ORDER BY id").all().map((row) => ({ ...row }));
  assert.deepEqual(migrated, [
    { id: "active-none", lifecycle: "active", legacyStatus: "active" },
    { id: "active-owner", lifecycle: "active", legacyStatus: "active" },
    { id: "archived", lifecycle: "archived", legacyStatus: "archived" },
    { id: "held", lifecycle: "active", legacyStatus: "hold" },
  ]);
  assert.throws(() => db.prepare("INSERT INTO assignments VALUES ('blocked', 'archived', 'p4', 'secondary', 'now')").run(), /TASK_ARCHIVED/);
  db.close();
});
