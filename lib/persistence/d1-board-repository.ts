import type { BoardRepository } from "@/lib/application/board-service";
import { ApplicationError, type BoardCommand, type Focus } from "@/lib/domain/contracts";
import { workflowDto, type TaskLifecycle, type TerminalOutcome } from "@/lib/task-workflow";
import { resolveStoredTaskColor } from "@/lib/task-colors";
import { resolveStoredPersonColor } from "@/lib/people-colors";

interface Statement { bind(...values: unknown[]): Statement; run(): Promise<{ meta?: { changes?: number }; changes?: number | bigint }>; first<T>(): Promise<T | null>; }
interface BatchResult<T> { results: T[]; meta?: { changes?: number }; changes?: number | bigint }
interface Database { prepare(sql: string): Statement; batch<T = unknown>(statements: Statement[]): Promise<Array<BatchResult<T>>>; }

export class D1BoardRepository implements BoardRepository {
  constructor(private readonly db: Database) {}

  async readBoard() {
    const [people, tasks, assignments, metadata] = await this.db.batch([
      this.db.prepare("SELECT id, name, role, color, color_id AS colorId, sort_order AS sortOrder FROM people ORDER BY sort_order, created_at, id"),
      this.db.prepare("SELECT t.id, t.title, t.description, t.category, t.color, t.color_id AS colorId, t.lifecycle, t.outcome, t.workflow_changed_at AS workflowChangedAt, t.revision, t.sort_order AS sortOrder, t.created_at AS createdAt, t.updated_at AS updatedAt, (SELECT COUNT(*) FROM assignments a WHERE a.task_id = t.id AND a.focus = 'primary') AS primaryCount FROM tasks t ORDER BY CASE WHEN t.lifecycle = 'archived' THEN 2 WHEN EXISTS (SELECT 1 FROM assignments a WHERE a.task_id = t.id AND a.focus = 'primary') THEN 1 ELSE 0 END, t.sort_order, t.created_at, t.id"),
      this.db.prepare("SELECT id, task_id AS taskId, person_id AS personId, focus, created_at AS createdAt FROM assignments ORDER BY created_at"),
      this.db.prepare("SELECT revision FROM board_metadata WHERE id = 1"),
    ]);
    const taskDtos = (tasks.results as Array<Record<string, unknown>>).map((task) => ({
      id: String(task.id), title: String(task.title), description: String(task.description), category: String(task.category), ...resolveStoredTaskColor(String(task.color), task.colorId ? String(task.colorId) : null),
      revision: Number(task.revision), sortOrder: Number(task.sortOrder), createdAt: String(task.createdAt), updatedAt: String(task.updatedAt),
      workflow: workflowDto({ lifecycle: task.lifecycle as TaskLifecycle, outcome: task.outcome as TerminalOutcome | null, changedAt: String(task.workflowChangedAt), revision: Number(task.revision) }, Number(task.primaryCount)),
    }));
    const revision = Number((metadata.results[0] as { revision?: number } | undefined)?.revision ?? 1);
    const personDtos = (people.results as Array<Record<string, unknown>>).map((person) => ({
      id: String(person.id), name: String(person.name), role: String(person.role), sortOrder: Number(person.sortOrder),
      ...resolveStoredPersonColor(String(person.color), person.colorId ? String(person.colorId) : null),
    }));
    let overfocusThreshold = 2.5;
    try {
      const settings = await this.db.prepare("SELECT overfocus_threshold AS overfocusThreshold FROM board_settings WHERE id = 1").first<{ overfocusThreshold: number }>();
      if (settings) overfocusThreshold = Number(settings.overfocusThreshold);
    } catch { /* A pre-migration database uses the versioned default until migrations run. */ }
    return { people: personDtos, tasks: taskDtos, assignments: assignments.results, revision: `board:${revision}`, settings: { overfocusThreshold } } as Awaited<ReturnType<BoardRepository["readBoard"]>>;
  }

  async execute(command: BoardCommand) {
    if (command.action === "updateFocusSettings") {
      const board = await this.readBoard();
      if (command.payload.expectedRevision && command.payload.expectedRevision !== board.revision) throw new ApplicationError("CONFLICT", "The board revision is stale.", "expectedRevision", { currentRevision: board.revision });
      const expectedNumber = Number((command.payload.expectedRevision ?? board.revision)?.slice("board:".length));
      const results = await this.db.batch([
        this.db.prepare("UPDATE board_settings SET overfocus_threshold = ? WHERE id = 1 AND (SELECT revision FROM board_metadata WHERE id = 1) = ?").bind(command.payload.overfocusThreshold, expectedNumber),
        this.db.prepare("UPDATE board_metadata SET revision = revision + 1 WHERE id = 1 AND revision = ?").bind(expectedNumber),
      ]);
      if (!Number(results[1]?.meta?.changes ?? results[1]?.changes ?? 0)) throw new ApplicationError("CONFLICT", "The board changed during the operation.", "expectedRevision");
      return;
    }
    if (command.action === "reorderPeople") {
      await this.reorderPerson(command.payload);
      return;
    }
    if (command.action === "reorderTasks") {
      await this.reorderTask(command.payload);
      return;
    }
    await this.executeMutation(command);
    await this.db.prepare("UPDATE board_metadata SET revision = revision + 1 WHERE id = 1").run();
  }

  private async executeMutation(command: Exclude<BoardCommand, { action: "reorderPeople" | "updateFocusSettings" }>) {
    switch (command.action) {
      case "addPerson": {
        const order = await this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM people").first<{ value: number }>();
        await this.db.prepare("INSERT INTO people (id, name, role, color, color_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), command.payload.name, command.payload.role, command.payload.color!, command.payload.colorId ?? null, order?.value ?? 0).run(); return;
      }
      case "updatePerson": await this.db.prepare("UPDATE people SET name = ?, role = ?, color = ?, color_id = ? WHERE id = ?").bind(command.payload.name, command.payload.role, command.payload.color!, command.payload.colorId ?? null, command.payload.id).run(); return;
      case "deletePerson": await this.db.prepare("DELETE FROM people WHERE id = ?").bind(command.payload.id).run(); return;
      case "addTask": {
        const order = await this.nextTaskOrder("unfocused");
        await this.db.prepare("INSERT INTO tasks (id, title, description, category, color, color_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), command.payload.title, command.payload.description, command.payload.category || "General", command.payload.color!, command.payload.colorId ?? null, order).run(); return;
      }
      case "updateTask": await this.db.prepare("UPDATE tasks SET title = ?, description = ?, category = ?, color = ?, color_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(command.payload.title, command.payload.description, command.payload.category || "General", command.payload.color!, command.payload.colorId ?? null, command.payload.id).run(); return;
      case "archiveTask": await this.transition(command.payload.id, "archived", command.payload.outcome ?? null, command.payload.expectedRevision); return;
      case "restoreTask": await this.transition(command.payload.id, "active", null, command.payload.expectedRevision); return;
      case "deleteTask": await this.db.prepare("DELETE FROM tasks WHERE id = ?").bind(command.payload.id).run(); return;
      case "assign": await this.assign(command.payload.taskId, command.payload.personId, command.payload.focus); return;
      case "unassign": {
        const existing = await this.db.prepare("SELECT focus FROM assignments WHERE task_id = ? AND person_id = ?").bind(command.payload.taskId, command.payload.personId).first<{ focus: Focus }>();
        const statements = [this.db.prepare("DELETE FROM assignments WHERE task_id = ? AND person_id = ?").bind(command.payload.taskId, command.payload.personId)];
        if (existing?.focus === "primary") {
          const nextOrder = await this.nextTaskOrder("unfocused");
          statements.push(this.db.prepare("UPDATE tasks SET sort_order = ?, workflow_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, revision = revision + 1 WHERE id = ?").bind(nextOrder, command.payload.taskId));
        }
        await this.db.batch(statements); return;
      }
    }
  }

  private async reorderPerson(payload: Extract<BoardCommand, { action: "reorderPeople" }>["payload"]) {
    const rows = await this.db.prepare("SELECT id FROM people ORDER BY sort_order, created_at, id").first<{ id: string }>();
    // `first` is deliberately used only as a cheap empty-board guard; the service validates IDs.
    if (!rows) throw new ApplicationError("NOT_FOUND", "Person not found.", "personId");
    const board = await this.readBoard();
    const expected = payload.expectedRevision ?? board.revision;
    const expectedNumber = Number(expected?.slice("board:".length));
    if (!Number.isSafeInteger(expectedNumber) || expectedNumber < 1) throw new ApplicationError("INVALID_INPUT", "Invalid board revision.", "expectedRevision");

    const orderedIds = board.people.map((person) => person.id).filter((id) => id !== payload.personId);
    let insertAt: number;
    if (payload.position === "first") insertAt = 0;
    else if (payload.position === "last") insertAt = orderedIds.length;
    else {
      const anchor = payload.beforePersonId ?? payload.afterPersonId!;
      const anchorIndex = orderedIds.indexOf(anchor);
      if (anchorIndex < 0) throw new ApplicationError("NOT_FOUND", "Anchor person not found.", payload.beforePersonId ? "beforePersonId" : "afterPersonId");
      insertAt = anchorIndex + (payload.afterPersonId ? 1 : 0);
    }
    orderedIds.splice(insertAt, 0, payload.personId);

    const cases = orderedIds.map(() => "WHEN ? THEN ?").join(" ");
    const values = orderedIds.flatMap((id, index) => [id, index]);
    const updates = await this.db.batch([
      this.db.prepare(`UPDATE people SET sort_order = CASE id ${cases} END WHERE id IN (${orderedIds.map(() => "?").join(",")}) AND (SELECT revision FROM board_metadata WHERE id = 1) = ?`)
        .bind(...values, ...orderedIds, expectedNumber),
      this.db.prepare("UPDATE board_metadata SET revision = revision + 1 WHERE id = 1 AND revision = ?").bind(expectedNumber),
    ]);
    const changed = Number(updates[1]?.meta?.changes ?? updates[1]?.changes ?? 0);
    if (!changed) {
      const current = await this.db.prepare("SELECT revision FROM board_metadata WHERE id = 1").first<{ revision: number }>();
      throw new ApplicationError("CONFLICT", "The board changed during the operation.", "expectedRevision", { currentRevision: `board:${current?.revision ?? expectedNumber}` });
    }
  }

  private async reorderTask(payload: Extract<BoardCommand, { action: "reorderTasks" }>["payload"]) {
    const board = await this.readBoard();
    const expected = payload.expectedRevision ?? board.revision;
    const expectedNumber = Number(expected?.slice("board:".length));
    if (!Number.isSafeInteger(expectedNumber) || expectedNumber < 1) throw new ApplicationError("INVALID_INPUT", "Invalid board revision.", "expectedRevision");
    const orderedIds = board.tasks.filter((task) => task.workflow.state === payload.state && task.id !== payload.taskId).map((task) => task.id);
    let insertAt: number;
    if (payload.position === "first") insertAt = 0;
    else if (payload.position === "last") insertAt = orderedIds.length;
    else {
      const anchor = payload.beforeTaskId ?? payload.afterTaskId!;
      const anchorIndex = orderedIds.indexOf(anchor);
      if (anchorIndex < 0) throw new ApplicationError("INVALID_INPUT", "Anchor task must be in the same workflow list.", payload.beforeTaskId ? "beforeTaskId" : "afterTaskId");
      insertAt = anchorIndex + (payload.afterTaskId ? 1 : 0);
    }
    orderedIds.splice(insertAt, 0, payload.taskId);
    const cases = orderedIds.map(() => "WHEN ? THEN ?").join(" ");
    const values = orderedIds.flatMap((id, index) => [id, index]);
    const updates = await this.db.batch([
      this.db.prepare(`UPDATE tasks SET sort_order = CASE id ${cases} END WHERE id IN (${orderedIds.map(() => "?").join(",")}) AND (SELECT revision FROM board_metadata WHERE id = 1) = ?`).bind(...values, ...orderedIds, expectedNumber),
      this.db.prepare("UPDATE board_metadata SET revision = revision + 1 WHERE id = 1 AND revision = ?").bind(expectedNumber),
    ]);
    const changed = Number(updates[1]?.meta?.changes ?? updates[1]?.changes ?? 0);
    if (!changed) {
      const current = await this.db.prepare("SELECT revision FROM board_metadata WHERE id = 1").first<{ revision: number }>();
      throw new ApplicationError("CONFLICT", "The board changed during the operation.", "expectedRevision", { currentRevision: `board:${current?.revision ?? expectedNumber}` });
    }
  }

  private async nextTaskOrder(state: "unfocused" | "focused" | "archived") {
    const board = await this.readBoard();
    return board.tasks.filter((task) => task.workflow.state === state).reduce((max, task) => Math.max(max, task.sortOrder), -1) + 1;
  }

  private async assign(taskId: string, personId: string, focus: Focus) {
    const prior = await this.db.prepare("SELECT focus FROM assignments WHERE task_id = ? AND person_id = ?").bind(taskId, personId).first<{ focus: Focus }>();
    const primary = await this.db.prepare("SELECT person_id AS personId FROM assignments WHERE task_id = ? AND focus = 'primary'").bind(taskId).first<{ personId: string }>();
    const upsert = this.db.prepare("INSERT INTO assignments (id, task_id, person_id, focus) VALUES (?, ?, ?, ?) ON CONFLICT(task_id, person_id) DO UPDATE SET focus = excluded.focus, created_at = CURRENT_TIMESTAMP").bind(crypto.randomUUID(), taskId, personId, focus);
    if (focus === "primary") {
      const statements = [this.db.prepare("DELETE FROM assignments WHERE task_id = ? AND focus = 'primary' AND person_id <> ?").bind(taskId, personId), upsert];
      if (!primary) {
        const nextOrder = await this.nextTaskOrder("focused");
        statements.push(this.db.prepare("UPDATE tasks SET sort_order = ?, workflow_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, revision = revision + 1 WHERE id = ?").bind(nextOrder, taskId));
      }
      await this.db.batch(statements);
    } else if (prior?.focus === "primary") {
      const nextOrder = await this.nextTaskOrder("unfocused");
      await this.db.batch([upsert, this.db.prepare("UPDATE tasks SET sort_order = ?, workflow_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, revision = revision + 1 WHERE id = ?").bind(nextOrder, taskId)]);
    } else await upsert.run();
  }

  async createBulkTasks(input: {
    items: Array<{ clientId: string; title: string; category: string; primaryPersonId?: string; color: string; colorId: string | null }>;
    idempotencyKey: string;
    expectedRevision: string;
  }) {
    const existing = await this.db.prepare("SELECT task_ids AS taskIds, revision FROM idempotency_keys WHERE key = ?").bind(input.idempotencyKey).first<{ taskIds: string; revision: number }>();
    if (existing) return { taskIds: JSON.parse(existing.taskIds) as string[], revision: `board:${existing.revision}` };

    const expectedNumber = Number(input.expectedRevision.slice("board:".length));
    let unfocusedOrder = await this.nextTaskOrder("unfocused");
    let focusedOrder = await this.nextTaskOrder("focused");
    const taskIds: string[] = [];
    const statements: Statement[] = [];
    // Every statement is gated on the same revision snapshot (rather than wrapped in an explicit ROLLBACK) so a
    // stale request becomes an all-statements-no-op batch, matching how reorderTasks/reorderPeople stay atomic.
    for (const item of input.items) {
      const id = crypto.randomUUID();
      taskIds.push(id);
      const sortOrder = item.primaryPersonId ? focusedOrder++ : unfocusedOrder++;
      statements.push(this.db.prepare(
        "INSERT INTO tasks (id, title, description, category, color, color_id, sort_order) SELECT ?, ?, '', ?, ?, ?, ? WHERE (SELECT revision FROM board_metadata WHERE id = 1) = ?",
      ).bind(id, item.title, item.category, item.color, item.colorId, sortOrder, expectedNumber));
      if (item.primaryPersonId) {
        statements.push(this.db.prepare(
          "INSERT INTO assignments (id, task_id, person_id, focus) SELECT ?, ?, ?, 'primary' WHERE (SELECT revision FROM board_metadata WHERE id = 1) = ?",
        ).bind(crypto.randomUUID(), id, item.primaryPersonId, expectedNumber));
      }
    }
    statements.push(this.db.prepare(
      "INSERT INTO idempotency_keys (key, task_ids, revision) SELECT ?, ?, ? WHERE (SELECT revision FROM board_metadata WHERE id = 1) = ?",
    ).bind(input.idempotencyKey, JSON.stringify(taskIds), expectedNumber + 1, expectedNumber));
    statements.push(this.db.prepare("UPDATE board_metadata SET revision = revision + 1 WHERE id = 1 AND revision = ?").bind(expectedNumber));

    const results = await this.db.batch(statements);
    const revisionUpdate = results[results.length - 1];
    const changed = Number(revisionUpdate?.meta?.changes ?? revisionUpdate?.changes ?? 0);
    if (!changed) throw new ApplicationError("CONFLICT", "The board changed during the operation.", "expectedRevision");
    return { taskIds, revision: `board:${expectedNumber + 1}` };
  }

  private async transition(id: string, lifecycle: TaskLifecycle, outcome: TerminalOutcome | null, expectedRevision?: number) {
    const task = await this.db.prepare("SELECT revision FROM tasks WHERE id = ?").bind(id).first<{ revision: number }>();
    if (!task) throw new ApplicationError("NOT_FOUND", "Task not found.", "id");
    if (expectedRevision !== undefined && task.revision !== expectedRevision) throw new ApplicationError("CONFLICT", "The task revision is stale.", "expectedRevision", { currentRevision: task.revision });
    const destination = lifecycle === "archived" ? "archived" : (await this.db.prepare("SELECT 1 AS found FROM assignments WHERE task_id = ? AND focus = 'primary'").bind(id).first<{ found: number }>()) ? "focused" : "unfocused";
    const sortOrder = await this.nextTaskOrder(destination);
    const result = await this.db.prepare("UPDATE tasks SET lifecycle = ?, outcome = ?, sort_order = ?, workflow_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, revision = revision + 1 WHERE id = ? AND revision = ?").bind(lifecycle, outcome, sortOrder, id, task.revision).run();
    if (!result.meta?.changes) throw new ApplicationError("CONFLICT", "The task changed during the operation.");
  }
}
