import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BoardService } from "../lib/application/board-service.ts";
import { ApplicationError, parseCommand } from "../lib/domain/contracts.ts";
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
    INSERT INTO board_metadata VALUES (1, 1);
    INSERT INTO people (id, name) VALUES ('p1', 'Ada');
    INSERT INTO tasks (id, title, sort_order, created_at) VALUES ('u1', 'First', 0, '2026-01-01'), ('u2', 'Second', 1, '2026-01-02'), ('u3', 'Third', 2, '2026-01-03'), ('f1', 'Focused', 0, '2026-01-04');
    INSERT INTO assignments (id, task_id, person_id, focus) VALUES ('a1', 'f1', 'p1', 'primary');
  `);
  return { database, service: new BoardService(new D1BoardRepository(new SqliteDatabaseAdapter(database))) };
}

test("tasks.reorder persists anchor and boundary ordering without changing task data", async () => {
  const { database, service } = fixture();
  try {
    const initial = await service.getBoard();
    const before = initial.tasks.find((task) => task.id === "u3")!;
    const moved = await service.execute(parseCommand({ action: "reorderTasks", payload: { taskId: "u3", state: "unfocused", beforeTaskId: "u1", expectedRevision: initial.revision } }));
    assert.deepEqual(moved.board.tasks.filter((task) => task.workflow.state === "unfocused").map((task) => task.id), ["u3", "u1", "u2"]);
    const after = moved.board.tasks.find((task) => task.id === "u3")!;
    assert.deepEqual({ ...after, sortOrder: before.sortOrder }, before);
    const last = await service.execute(parseCommand({ action: "reorderTasks", payload: { taskId: "u3", state: "unfocused", position: "last", expectedRevision: moved.board.revision } }));
    assert.deepEqual(last.board.tasks.filter((task) => task.workflow.state === "unfocused").map((task) => task.id), ["u1", "u2", "u3"]);
  } finally { database.close(); }
});

test("tasks.reorder rejects cross-list anchors and stale revisions", async () => {
  const { database, service } = fixture();
  try {
    const initial = await service.getBoard();
    await assert.rejects(() => service.execute(parseCommand({ action: "reorderTasks", payload: { taskId: "u1", state: "unfocused", beforeTaskId: "f1", expectedRevision: initial.revision } })), (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_INPUT");
    await service.execute(parseCommand({ action: "reorderTasks", payload: { taskId: "u1", state: "unfocused", position: "last", expectedRevision: initial.revision } }));
    await assert.rejects(() => service.execute(parseCommand({ action: "reorderTasks", payload: { taskId: "u2", state: "unfocused", position: "last", expectedRevision: initial.revision } })), (error: unknown) => error instanceof ApplicationError && error.code === "CONFLICT");
  } finally { database.close(); }
});

test("workflow transitions append to the destination list deterministically", async () => {
  const { database, service } = fixture();
  try {
    const focused = await service.execute(parseCommand({ action: "assign", payload: { taskId: "u1", personId: "p1", focus: "primary" } }));
    assert.deepEqual(focused.board.tasks.filter((task) => task.workflow.state === "focused").map((task) => task.id), ["f1", "u1"]);
    const revision = focused.board.tasks.find((task) => task.id === "u1")!.revision;
    const archived = await service.execute(parseCommand({ action: "archiveTask", payload: { id: "u1", expectedRevision: revision } }));
    assert.equal(archived.board.tasks.filter((task) => task.workflow.state === "archived").at(-1)?.id, "u1");
  } finally { database.close(); }
});

test("tasks.reorder schema requires one safe, non-self target", () => {
  assert.throws(() => parseCommand({ action: "reorderTasks", payload: { taskId: "u1", state: "unfocused" } }), ApplicationError);
  assert.throws(() => parseCommand({ action: "reorderTasks", payload: { taskId: "u1", state: "unfocused", afterTaskId: "u1" } }), ApplicationError);
});
