import assert from "node:assert/strict";
import test from "node:test";
import { BoardService, type BoardRepository } from "../lib/application/board-service";
import { ApplicationError, parseCommand, type BoardCommand } from "../lib/domain/contracts";

function fixture(): BoardRepository {
  const state = {
    people: [{ id: "p1", name: "Ada", role: "Lead", color: "#123456", colorId: null, sortOrder: 0 }],
    tasks: [{ id: "t1", title: "Plan", description: "", category: "General", color: "#654321", colorId: null, workflow: { state: "unfocused" as const, changedAt: "2026-01-01T00:00:00.000Z" }, revision: 1, sortOrder: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
    assignments: [] as Array<{ id: string; taskId: string; personId: string; focus: "primary" | "secondary" | "tertiary"; createdAt: string }>,
  };
  return { async readBoard() { return structuredClone(state); }, async execute(command: BoardCommand) { if (command.action === "assign") state.assignments.push({ id: "a1", ...command.payload, createdAt: "2026-01-01T00:00:00.000Z" }); } };
}

test("service returns a versioned, deterministic board envelope", async () => {
  const board = await new BoardService(fixture(), () => new Date("2026-02-01T00:00:00.000Z")).getBoard();
  assert.equal(board.apiVersion, 1);
  assert.equal(board.revision, "2026-01-01T00:00:00.000Z");
  assert.equal(board.savedAt, "2026-02-01T00:00:00.000Z");
});

test("application invariants reject missing people before persistence", async () => {
  const service = new BoardService(fixture());
  await assert.rejects(
    () => service.execute(parseCommand({ action: "assign", payload: { taskId: "t1", personId: "missing", focus: "primary" } })),
    (error: unknown) => error instanceof ApplicationError && error.code === "NOT_FOUND" && error.field === "personId",
  );
});

test("command parser strips no unknown fields and reports a stable error", () => {
  assert.throws(() => parseCommand({ action: "deleteTask", payload: { id: "t1", sql: "DROP TABLE tasks" } }), (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_INPUT");
});
