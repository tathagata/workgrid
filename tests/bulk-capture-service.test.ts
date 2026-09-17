import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BoardService, type BoardRepository } from "../lib/application/board-service";
import { ApplicationError } from "../lib/domain/contracts";

function fixture() {
  const state = {
    people: [{ id: "p1", name: "Ada Lovelace", role: "Lead", color: "#123456", colorId: null as string | null, sortOrder: 0 }],
    tasks: [] as Array<{ id: string; title: string; description: string; category: string; color: string; colorId: string | null; workflow: { state: string; changedAt: string }; revision: number; sortOrder: number; createdAt: string; updatedAt: string }>,
    assignments: [] as Array<{ id: string; taskId: string; personId: string; focus: string; createdAt: string }>,
    revision: 1,
  };
  const idempotency = new Map<string, { taskIds: string[]; revision: number }>();

  const repository: BoardRepository = {
    async readBoard() {
      return { people: structuredClone(state.people), tasks: structuredClone(state.tasks), assignments: structuredClone(state.assignments), revision: `board:${state.revision}` } as never;
    },
    async execute() { /* not exercised by these tests */ },
    async createBulkTasks(input) {
      const existing = idempotency.get(input.idempotencyKey);
      if (existing) return { taskIds: existing.taskIds, revision: `board:${existing.revision}` };
      const expectedNumber = Number(input.expectedRevision.slice("board:".length));
      if (expectedNumber !== state.revision) throw new ApplicationError("CONFLICT", "The board changed during the operation.", "expectedRevision");
      const taskIds: string[] = [];
      for (const item of input.items) {
        const id = randomUUID();
        taskIds.push(id);
        state.tasks.push({
          id, title: item.title, description: "", category: item.category, color: item.color, colorId: item.colorId,
          workflow: { state: item.primaryPersonId ? "focused" : "unfocused", changedAt: "2026-01-01T00:00:00.000Z" },
          revision: 1, sortOrder: state.tasks.length, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        });
        if (item.primaryPersonId) state.assignments.push({ id: randomUUID(), taskId: id, personId: item.primaryPersonId, focus: "primary", createdAt: "2026-01-01T00:00:00.000Z" });
      }
      state.revision += 1;
      idempotency.set(input.idempotencyKey, { taskIds, revision: state.revision });
      return { taskIds, revision: `board:${state.revision}` };
    },
  };
  return { state, repository };
}

test("parseBulkTasks resolves against the live people list and rejects malformed input", async () => {
  const { repository } = fixture();
  const service = new BoardService(repository);
  const result = await service.parseBulkTasks({ text: "Ship it @primary:p1\nUnowned work" });
  assert.equal(result.items[0].primaryPersonId, "p1");
  assert.equal(result.items[0].workflowIntent, "focused");
  assert.equal(result.items[1].workflowIntent, "unfocused");

  await assert.rejects(service.parseBulkTasks({ text: "ok", extra: "field" }), (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_INPUT");
});

test("createBulkTasks creates every item and its primary assignment atomically, bumping the revision once", async () => {
  const { state, repository } = fixture();
  const service = new BoardService(repository);
  const board = await service.getBoard();
  const result = await service.createBulkTasks({
    syntaxVersion: "1", mode: "atomic", idempotencyKey: "bulk-key-1", expectedRevision: board.revision,
    items: [{ clientId: "line-1", title: "Investigate latency" }, { clientId: "line-2", title: "Ship it", primaryPersonId: "p1" }],
  });
  assert.equal(result.created.length, 2);
  assert.equal(result.assignments.length, 1);
  assert.equal(result.assignments[0].personId, "p1");
  assert.equal(state.revision, 2);
  assert.equal(result.revision, "board:2");
});

test("re-validates a primary person that no longer exists instead of trusting the client's preview", async () => {
  const { repository } = fixture();
  const service = new BoardService(repository);
  const board = await service.getBoard();
  await assert.rejects(
    service.createBulkTasks({ syntaxVersion: "1", mode: "atomic", idempotencyKey: "bulk-key-2", expectedRevision: board.revision, items: [{ clientId: "line-1", title: "Ship it", primaryPersonId: "deleted-person" }] }),
    (error: unknown) => error instanceof ApplicationError && error.code === "NOT_FOUND" && error.field === "items.0.primaryPersonId",
  );
});

test("a stale expected revision is a conflict and creates nothing", async () => {
  const { state, repository } = fixture();
  const service = new BoardService(repository);
  await assert.rejects(
    service.createBulkTasks({ syntaxVersion: "1", mode: "atomic", idempotencyKey: "bulk-key-3", expectedRevision: "board:99", items: [{ clientId: "line-1", title: "Ship it" }] }),
    (error: unknown) => error instanceof ApplicationError && error.code === "CONFLICT",
  );
  assert.equal(state.tasks.length, 0);
});

test("retrying the same idempotency key returns the original result and creates no duplicates", async () => {
  const { state, repository } = fixture();
  const service = new BoardService(repository);
  const board = await service.getBoard();
  const input = { syntaxVersion: "1" as const, mode: "atomic" as const, idempotencyKey: "bulk-key-4", expectedRevision: board.revision, items: [{ clientId: "line-1", title: "Ship it" }] };
  const first = await service.createBulkTasks(input);
  const second = await service.createBulkTasks(input);
  assert.deepEqual(first.created.map((t) => t.id), second.created.map((t) => t.id));
  assert.equal(state.tasks.length, 1);
});

test("auto-allocated colors are distinct across a batch rather than all identical", async () => {
  const { repository } = fixture();
  const service = new BoardService(repository);
  const board = await service.getBoard();
  const result = await service.createBulkTasks({
    syntaxVersion: "1", mode: "atomic", idempotencyKey: "bulk-key-5", expectedRevision: board.revision,
    items: [{ clientId: "line-1", title: "One" }, { clientId: "line-2", title: "Two" }, { clientId: "line-3", title: "Three" }],
  });
  const colorIds = new Set(result.created.map((task) => task.colorId));
  assert.equal(colorIds.size, 3);
});

test("bulk creation is unsupported without a repository implementation, not silently ignored", async () => {
  const { repository } = fixture();
  const bare: BoardRepository = { readBoard: repository.readBoard, execute: repository.execute };
  const service = new BoardService(bare);
  const board = await service.getBoard();
  await assert.rejects(
    service.createBulkTasks({ syntaxVersion: "1", mode: "atomic", idempotencyKey: "bulk-key-6", expectedRevision: board.revision, items: [{ clientId: "line-1", title: "Ship it" }] }),
    (error: unknown) => error instanceof ApplicationError && error.code === "UNSUPPORTED",
  );
});
