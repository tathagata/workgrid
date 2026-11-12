import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BoardService } from "../lib/application/board-service.ts";
import { ApplicationError, parseCommand } from "../lib/domain/contracts.ts";
import { D1BoardRepository } from "../lib/persistence/d1-board-repository.ts";
import { SqliteDatabaseAdapter } from "../mcp/sqlite-database.ts";

/** Same schema as task-ordering.test.ts, on the real D1 repository over node:sqlite. */
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

test("task and person updates with a stale expectedRevision conflict and change nothing", async () => {
  const { database, service } = fixture();
  try {
    const initial = await service.getBoard();
    // A concurrent writer (e.g. the web UI) changes the board after the client's read.
    await service.execute(parseCommand({ action: "updateTask", payload: { id: "u1", title: "First", description: "Edited in the UI", category: "Ops" } }));
    const isConflict = (error: unknown) => error instanceof ApplicationError && error.code === "CONFLICT" && error.field === "expectedRevision";
    await assert.rejects(() => service.execute(parseCommand({ action: "updateTask", payload: { id: "u1", title: "Renamed", description: "", category: "General", expectedRevision: initial.revision } })), isConflict);
    await assert.rejects(() => service.execute(parseCommand({ action: "updatePerson", payload: { id: "p1", name: "Ada L", role: "", expectedRevision: initial.revision } })), isConflict);
    const after = await service.getBoard();
    const task = after.tasks.find((item) => item.id === "u1")!;
    assert.equal(task.title, "First");
    assert.equal(task.description, "Edited in the UI");
    assert.equal(after.people.find((item) => item.id === "p1")!.name, "Ada");
  } finally {
    database.close();
  }
});

test("updates at the current expectedRevision apply and advance the revision once", async () => {
  const { database, service } = fixture();
  try {
    const initial = await service.getBoard();
    const updated = await service.execute(parseCommand({ action: "updateTask", payload: { id: "u2", title: "Second v2", description: "", category: "General", expectedRevision: initial.revision } }));
    assert.equal(updated.board.tasks.find((item) => item.id === "u2")!.title, "Second v2");
    assert.equal(updated.board.revision, "board:2");
    const person = await service.execute(parseCommand({ action: "updatePerson", payload: { id: "p1", name: "Ada Lovelace", role: "Eng", expectedRevision: updated.board.revision } }));
    assert.equal(person.board.people[0].name, "Ada Lovelace");
    assert.equal(person.board.revision, "board:3");
    // Without expectedRevision, updates keep their existing last-writer-wins behavior.
    const unpinned = await service.execute(parseCommand({ action: "updateTask", payload: { id: "u2", title: "Second v3", description: "", category: "General" } }));
    assert.equal(unpinned.board.revision, "board:4");
  } finally {
    database.close();
  }
});
