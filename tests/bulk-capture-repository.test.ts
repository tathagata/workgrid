import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BoardService } from "../lib/application/board-service.ts";
import { ApplicationError } from "../lib/domain/contracts.ts";
import { D1BoardRepository } from "../lib/persistence/d1-board-repository.ts";
import { SqliteDatabaseAdapter } from "../mcp/sqlite-database.ts";

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#2f6f65', color_id TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'General', color TEXT NOT NULL DEFAULT '#5b67a5', color_id TEXT, lifecycle TEXT NOT NULL DEFAULT 'active', outcome TEXT, workflow_changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, revision INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE assignments (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, person_id TEXT NOT NULL, focus TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(task_id, person_id), FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE, FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE);
    CREATE TABLE board_metadata (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL CHECK(revision > 0));
    CREATE TABLE idempotency_keys (key TEXT PRIMARY KEY, task_ids TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO board_metadata VALUES (1, 1);
    INSERT INTO people (id, name) VALUES ('p1', 'Ada');
    INSERT INTO tasks (id, title, sort_order, created_at) VALUES ('u1', 'Existing unfocused', 0, '2026-01-01');
  `);
  return { database, service: new BoardService(new D1BoardRepository(new SqliteDatabaseAdapter(database))) };
}

test("bulk creation inserts tasks and primary assignments atomically, appended after existing tasks, in one revision bump", async () => {
  const { database, service } = fixture();
  try {
    const before = await service.getBoard();
    const result = await service.createBulkTasks({
      syntaxVersion: "1", mode: "atomic", idempotencyKey: "sql-test-key-1", expectedRevision: before.revision,
      items: [{ clientId: "line-1", title: "New unfocused" }, { clientId: "line-2", title: "New focused", primaryPersonId: "p1" }],
    });
    assert.equal(result.created.length, 2);
    assert.equal(result.assignments.length, 1);
    assert.equal(result.revision, "board:2");

    const after = await service.getBoard();
    assert.deepEqual(after.tasks.filter((t) => t.workflow.state === "unfocused").map((t) => t.title), ["Existing unfocused", "New unfocused"]);
    assert.deepEqual(after.tasks.filter((t) => t.workflow.state === "focused").map((t) => t.title), ["New focused"]);
  } finally { database.close(); }
});

test("a stale expected revision leaves the database completely unchanged, not partially written", async () => {
  const { database, service } = fixture();
  try {
    await assert.rejects(
      service.createBulkTasks({ syntaxVersion: "1", mode: "atomic", idempotencyKey: "sql-test-key-2", expectedRevision: "board:99", items: [{ clientId: "line-1", title: "Should not exist" }] }),
      (error: unknown) => error instanceof ApplicationError && error.code === "CONFLICT",
    );
    const board = await service.getBoard();
    assert.equal(board.tasks.length, 1);
    assert.equal(board.revision, "board:1");
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get()!.n, 0);
  } finally { database.close(); }
});

test("retrying the same idempotency key at the SQL layer returns the original tasks and writes nothing new", async () => {
  const { database, service } = fixture();
  try {
    const before = await service.getBoard();
    const input = { syntaxVersion: "1" as const, mode: "atomic" as const, idempotencyKey: "sql-test-key-3", expectedRevision: before.revision, items: [{ clientId: "line-1", title: "Only once" }] };
    const first = await service.createBulkTasks(input);
    const second = await service.createBulkTasks(input);
    assert.deepEqual(first.created.map((t) => t.id), second.created.map((t) => t.id));
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Only once'").get()!.n, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get()!.n, 1);
  } finally { database.close(); }
});
