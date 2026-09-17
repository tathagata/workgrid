import assert from "node:assert/strict";
import test from "node:test";
import { BoardService, type BoardRepository } from "../lib/application/board-service";
import { ApplicationError, parseCommand, type BoardCommand, type TaskDto } from "../lib/domain/contracts";
import { allocateTaskColor, resolveStoredTaskColor, TASK_PALETTE, TASK_PALETTE_VERSION } from "../lib/task-colors";

const workflow = { state: "unfocused" as const, changedAt: "2026-01-01T00:00:00.000Z" };
function task(id: string, color: string, colorId: TaskDto["colorId"], state: "unfocused" | "focused" | "archived" = "unfocused"): TaskDto {
  return { id, title: id, description: "", category: "General", color, colorId, workflow: { ...workflow, state }, revision: 1, sortOrder: 0, createdAt: workflow.changedAt, updatedAt: workflow.changedAt };
}

test("palette is versioned, has 12 distinct choices, and text meets WCAG AA", () => {
  assert.equal(TASK_PALETTE_VERSION, 1);
  assert.equal(TASK_PALETTE.length, 12);
  assert.equal(new Set(TASK_PALETTE.map(({ id }) => id)).size, 12);
  assert.equal(new Set(TASK_PALETTE.map(({ value }) => value)).size, 12);
  for (const entry of TASK_PALETTE) assert.ok(contrast(entry.value, entry.foreground) >= 4.5, `${entry.id} contrast is too low`);
});

test("least-used allocation is deterministic, ignores archived tasks, and wraps after exhaustion", () => {
  assert.deepEqual(allocateTaskColor([]), { colorId: "ocean", color: "#1D4ED8" });
  const oneEach = TASK_PALETTE.map((entry, index) => task(String(index), entry.value, entry.id));
  assert.equal(allocateTaskColor(oneEach).colorId, "ocean", "palette order breaks equal-count ties");
  oneEach.push(task("extra", TASK_PALETTE[0].value, TASK_PALETTE[0].id));
  oneEach.push(task("archived", TASK_PALETTE[1].value, TASK_PALETTE[1].id, "archived"));
  assert.equal(allocateTaskColor(oneEach).colorId, "indigo");
});

test("legacy/custom colors survive while known legacy values recover palette identity", () => {
  assert.deepEqual(resolveStoredTaskColor("#1d4ed8", null), { colorId: "ocean", color: "#1D4ED8" });
  assert.deepEqual(resolveStoredTaskColor("#123456", null), { colorId: null, color: "#123456" });
});

test("service assigns omitted task colors and honors explicit palette choices", async () => {
  const calls: BoardCommand[] = [];
  const tasks: TaskDto[] = [task("t1", "#1D4ED8", "ocean")];
  const repository: BoardRepository = {
    async readBoard() { return { people: [], tasks, assignments: [] }; },
    async execute(command) {
      calls.push(command);
      if (command.action === "addTask") tasks.unshift(task("new", command.payload.color!, command.payload.colorId ?? null));
    },
  };
  const service = new BoardService(repository);
  await service.execute(parseCommand({ action: "addTask", payload: { title: "Automatic" } }));
  assert.deepEqual(calls[0]?.action === "addTask" ? { color: calls[0].payload.color, colorId: calls[0].payload.colorId } : null, { color: "#4338CA", colorId: "indigo" });
  await service.execute(parseCommand({ action: "addTask", payload: { title: "Explicit", colorId: "berry" } }));
  assert.equal(calls[1]?.action === "addTask" ? calls[1].payload.color : null, "#BE185D");
});

test("task color validation rejects unknown IDs, style injection, and mismatched pairs", () => {
  for (const payload of [
    { title: "Bad", colorId: "not-a-color" },
    { title: "Bad", color: "red; background:url(evil)" },
    { title: "Bad", colorId: "ocean", color: "#BE185D" },
  ]) assert.throws(() => parseCommand({ action: "addTask", payload }), (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_INPUT");
});

function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}
