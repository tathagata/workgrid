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
    CREATE TABLE assignments (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, person_id TEXT NOT NULL, focus TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE, FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE);
    CREATE TABLE board_metadata (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL CHECK(revision > 0));
    INSERT INTO board_metadata VALUES (1, 1);
    INSERT INTO people (id, name, sort_order, created_at) VALUES ('p1', 'Ada', 7, '2026-01-01'), ('p2', 'Grace', 7, '2026-01-02'), ('p3', 'Linus', 30, '2026-01-03');
    INSERT INTO tasks (id, title) VALUES ('t1', 'Ship');
    INSERT INTO assignments (id, task_id, person_id, focus) VALUES ('a1', 't1', 'p2', 'primary');
  `);
  return { database, service: new BoardService(new D1BoardRepository(new SqliteDatabaseAdapter(database))) };
}

test("people.reorder uses anchors, persists canonical order, and keeps assignments attached", async () => {
  const { database, service } = fixture();
  try {
    const initial = await service.getBoard();
    assert.deepEqual(initial.people.map((person) => person.id), ["p1", "p2", "p3"]);
    const result = await service.execute(parseCommand({ action: "reorderPeople", payload: { personId: "p3", beforePersonId: "p1", expectedRevision: initial.revision } }));
    assert.deepEqual(result.board.people.map((person) => person.id), ["p3", "p1", "p2"]);
    assert.deepEqual(result.board.people.map((person) => person.sortOrder), [0, 1, 2]);
    assert.equal(result.board.assignments[0].personId, "p2");
    assert.notEqual(result.board.revision, initial.revision);
  } finally { database.close(); }
});

test("people.reorder supports boundaries and rejects stale revisions", async () => {
  const { database, service } = fixture();
  try {
    const initial = await service.getBoard();
    const first = await service.execute(parseCommand({ action: "reorderPeople", payload: { personId: "p1", position: "last", expectedRevision: initial.revision } }));
    assert.deepEqual(first.board.people.map((person) => person.id), ["p2", "p3", "p1"]);
    await assert.rejects(
      () => service.execute(parseCommand({ action: "reorderPeople", payload: { personId: "p2", position: "last", expectedRevision: initial.revision } })),
      (error: unknown) => error instanceof ApplicationError && error.code === "CONFLICT",
    );
  } finally { database.close(); }
});

test("people.reorder requires exactly one non-self anchor", () => {
  assert.throws(() => parseCommand({ action: "reorderPeople", payload: { personId: "p1" } }), ApplicationError);
  assert.throws(() => parseCommand({ action: "reorderPeople", payload: { personId: "p1", beforePersonId: "p2", position: "first" } }), ApplicationError);
  assert.throws(() => parseCommand({ action: "reorderPeople", payload: { personId: "p1", afterPersonId: "p1" } }), ApplicationError);
});
