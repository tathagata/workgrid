import { API_VERSION, ApplicationError, type BoardCommand, type BoardDto } from "@/lib/domain/contracts";
import { allocateTaskColor, resolveStoredTaskColor, taskAppearance, taskPaletteEntry } from "@/lib/task-colors";
import { allocatePersonColor, peopleAppearance, peoplePaletteEntry, resolveStoredPersonColor } from "@/lib/people-colors";
import { calculatePersonLoads, DEFAULT_PERSON_LOAD_POLICY, validatePersonLoadPolicy, type PersonLoadPolicy } from "@/lib/person-load";
import { assessTaskFocus, DEFAULT_OVERFOCUS_THRESHOLD, FOCUS_ASSESSMENT_VERSION, FOCUS_WEIGHTS } from "@/lib/task-focus";
import {
  BULK_MAX_ITEMS, bulkCreateInputSchema, bulkParseInputSchema, parseBulkCaptureText,
  type BulkCreateInput, type BulkParseResult,
} from "@/lib/bulk-capture";

export interface BoardRepository {
  readBoard(): Promise<Omit<BoardDto, "apiVersion" | "revision" | "savedAt" | "appearance" | "workload" | "settings"> & { revision?: string; settings?: { overfocusThreshold: number } }>;
  execute(command: BoardCommand): Promise<void>;
  /** Optional: only persistence adapters that support bulk task capture need implement this. */
  createBulkTasks?(input: {
    items: Array<{ clientId: string; title: string; category: string; primaryPersonId?: string; color: string; colorId: string | null }>;
    idempotencyKey: string;
    expectedRevision: string;
  }): Promise<{ taskIds: string[]; revision: string }>;
}

export interface MutationResult {
  board: BoardDto;
  changed: { kind: "person" | "task" | "assignment"; id: string } | null;
}

export class BoardService {
  constructor(private readonly repository: BoardRepository, private readonly now = () => new Date(), private readonly loadPolicy: PersonLoadPolicy = DEFAULT_PERSON_LOAD_POLICY) {
    validatePersonLoadPolicy(loadPolicy);
  }

  async getBoard(): Promise<BoardDto> {
    const data = await this.repository.readBoard();
    const savedAt = this.now().toISOString();
    const latest = data.tasks.reduce((value, task) => task.updatedAt > value ? task.updatedAt : value, "");
    const { revision, settings: storedSettings, ...board } = data;
    const overfocusThreshold = storedSettings?.overfocusThreshold ?? DEFAULT_OVERFOCUS_THRESHOLD;
    const tasks = board.tasks.map((task) => ({ ...task, focusAssessment: task.workflow.state === "archived" ? null : assessTaskFocus(board.assignments.filter((item) => item.taskId === task.id), overfocusThreshold) }));
    const loadByPerson = calculatePersonLoads(board.people, board.tasks, board.assignments, this.loadPolicy);
    const people = board.people.map((person) => ({ ...person, load: loadByPerson.get(person.id)! }));
    return { apiVersion: API_VERSION, ...board, tasks, people, revision: revision ?? (latest || savedAt), savedAt,
      appearance: { paletteVersion: peopleAppearance().paletteVersion }, workload: structuredClone(this.loadPolicy),
      settings: { focusAssessmentVersion: FOCUS_ASSESSMENT_VERSION, overfocusThreshold, weights: FOCUS_WEIGHTS } };
  }

  getAppearance() { return { ...taskAppearance(), peoplePalette: peopleAppearance().peoplePalette }; }

  async getPeopleLoads(options: { state?: "low" | "balanced" | "overloaded"; sort?: "canonical" | "highest" | "lowest" } = {}) {
    const board = await this.getBoard();
    const filtered = options.state ? board.people.filter((person) => person.load?.state === options.state) : board.people;
    const people = options.sort && options.sort !== "canonical"
      ? [...filtered].sort((left, right) => options.sort === "highest" ? right.load!.score - left.load!.score : left.load!.score - right.load!.score)
      : filtered;
    return { calculation: board.workload, people: people.map(({ id, name, sortOrder, load }) => ({ id, name, sortOrder, load })) };
  }

  /** Pure parsing against the current people list. Never mutates; safe to call repeatedly while a user types. */
  async parseBulkTasks(input: unknown): Promise<BulkParseResult> {
    const parsed = bulkParseInputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ApplicationError("INVALID_INPUT", issue?.message ?? "Invalid bulk capture request.", issue?.path.join("."));
    }
    const board = await this.getBoard();
    const result = parseBulkCaptureText(parsed.data.text, { people: board.people.map((person) => ({ id: person.id, name: person.name })) });
    if (result.items.length > BULK_MAX_ITEMS) {
      throw new ApplicationError("PAYLOAD_TOO_LARGE", `Bulk capture accepts at most ${BULK_MAX_ITEMS} tasks per submission; found ${result.items.length}.`, "text");
    }
    return result;
  }

  /**
   * Re-validates every item against the current board rather than trusting the client's preview: a person or
   * color the client resolved a moment ago may no longer exist. Atomic — the repository either creates every
   * item and bumps the revision once, or creates nothing. Idempotent — retrying the same key returns the
   * original result without creating duplicates.
   */
  async createBulkTasks(input: unknown): Promise<{ created: BoardDto["tasks"]; assignments: BoardDto["assignments"]; revision: string }> {
    const parsed = bulkCreateInputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ApplicationError("INVALID_INPUT", issue?.message ?? "Invalid bulk capture request.", issue?.path.join("."));
    }
    if (!this.repository.createBulkTasks) throw new ApplicationError("UNSUPPORTED", "Bulk task creation is not supported by this persistence adapter.");
    const { items, expectedRevision }: BulkCreateInput = parsed.data;
    const board = await this.getBoard();
    // The repository checks the idempotency key before it checks the revision, so a retry of an
    // already-completed submission succeeds even though the board's revision moved on when it first succeeded.
    // Resolving colors/people against a fresh read here is therefore best-effort on a retry, not authoritative.
    const peopleIds = new Set(board.people.map((person) => person.id));
    const workingTasks: Array<{ color: string; colorId: string | null; workflow: { state: string } }> = board.tasks.map((task) => ({ color: task.color, colorId: task.colorId, workflow: task.workflow }));
    const resolved = items.map((item, index) => {
      if (item.primaryPersonId && !peopleIds.has(item.primaryPersonId)) {
        throw new ApplicationError("NOT_FOUND", "Primary person not found.", `items.${index}.primaryPersonId`);
      }
      let colorId = item.colorId ?? null;
      let color: string;
      if (colorId) color = taskPaletteEntry(colorId)!.value;
      else ({ colorId, color } = allocateTaskColor(workingTasks));
      workingTasks.push({ color, colorId, workflow: { state: item.primaryPersonId ? "focused" : "unfocused" } });
      return { clientId: item.clientId, title: item.title, category: item.category || "General", primaryPersonId: item.primaryPersonId, color, colorId };
    });

    const { taskIds, revision } = await this.repository.createBulkTasks({ items: resolved, idempotencyKey: parsed.data.idempotencyKey, expectedRevision: expectedRevision ?? board.revision });
    const after = await this.getBoard();
    const idSet = new Set(taskIds);
    return { created: after.tasks.filter((task) => idSet.has(task.id)), assignments: after.assignments.filter((assignment) => idSet.has(assignment.taskId)), revision: after.revision === revision ? after.revision : revision };
  }

  async execute(command: BoardCommand): Promise<MutationResult> {
    command = await this.resolvePersonColor(command);
    command = await this.resolveTaskColor(command);
    await this.enforceInvariants(command);
    await this.repository.execute(command);
    const board = await this.getBoard();
    return { board, changed: identifyChanged(command, board) };
  }

  private async resolvePersonColor(command: BoardCommand): Promise<BoardCommand> {
    if (command.action !== "addPerson" && command.action !== "updatePerson") return command;
    const board = await this.repository.readBoard();
    const payload = command.payload;
    let resolved;
    if (payload.colorId) {
      const entry = peoplePaletteEntry(payload.colorId)!;
      resolved = { colorId: entry.id, color: entry.value };
    } else if (payload.color) {
      resolved = resolveStoredPersonColor(payload.color);
    } else if (command.action === "addPerson") {
      resolved = allocatePersonColor(board.people);
    } else {
      const existing = board.people.find((person) => person.id === payload.id);
      if (!existing) throw new ApplicationError("NOT_FOUND", "Person not found.", "id");
      resolved = { colorId: existing.colorId, color: existing.color };
    }
    return { ...command, payload: { ...payload, ...resolved } } as BoardCommand;
  }

  private async resolveTaskColor(command: BoardCommand): Promise<BoardCommand> {
    if (command.action !== "addTask" && command.action !== "updateTask") return command;
    const board = await this.repository.readBoard();
    const payload = command.payload;
    let resolved;
    if (payload.colorId) {
      const entry = taskPaletteEntry(payload.colorId)!;
      resolved = { colorId: entry.id, color: entry.value };
    } else if (payload.color) {
      resolved = resolveStoredTaskColor(payload.color);
    } else if (command.action === "addTask") {
      resolved = allocateTaskColor(board.tasks);
    } else {
      const existing = board.tasks.find((task) => task.id === payload.id);
      if (!existing) throw new ApplicationError("NOT_FOUND", "Task not found.", "id");
      resolved = { colorId: existing.colorId, color: existing.color };
    }
    return { ...command, payload: { ...payload, ...resolved } } as BoardCommand;
  }

  private async enforceInvariants(command: BoardCommand) {
    if (command.action === "updateFocusSettings") {
      const board = await this.repository.readBoard();
      if (command.payload.expectedRevision && board.revision && command.payload.expectedRevision !== board.revision) throw new ApplicationError("CONFLICT", "The board revision is stale.", "expectedRevision", { currentRevision: board.revision });
      return;
    }
    if (command.action === "reorderPeople") {
      const board = await this.repository.readBoard();
      if (!board.people.some((item) => item.id === command.payload.personId)) throw new ApplicationError("NOT_FOUND", "Person not found.", "personId");
      const anchorId = command.payload.beforePersonId ?? command.payload.afterPersonId;
      if (anchorId && !board.people.some((item) => item.id === anchorId)) throw new ApplicationError("NOT_FOUND", "Anchor person not found.", command.payload.beforePersonId ? "beforePersonId" : "afterPersonId");
      if (command.payload.expectedRevision && board.revision && command.payload.expectedRevision !== board.revision) {
        throw new ApplicationError("CONFLICT", "The board revision is stale.", "expectedRevision", { currentRevision: board.revision });
      }
      return;
    }
    if (command.action === "reorderTasks") {
      const board = await this.repository.readBoard();
      const task = board.tasks.find((item) => item.id === command.payload.taskId);
      if (!task) throw new ApplicationError("NOT_FOUND", "Task not found.", "taskId");
      if (task.workflow.state !== command.payload.state) throw new ApplicationError("FORBIDDEN_STATE", "Task is not in the requested workflow list.", "state");
      const anchorId = command.payload.beforeTaskId ?? command.payload.afterTaskId;
      const anchor = anchorId ? board.tasks.find((item) => item.id === anchorId) : undefined;
      if (anchorId && !anchor) throw new ApplicationError("NOT_FOUND", "Anchor task not found.", command.payload.beforeTaskId ? "beforeTaskId" : "afterTaskId");
      if (anchor && anchor.workflow.state !== command.payload.state) throw new ApplicationError("INVALID_INPUT", "Anchor task must be in the same workflow list.", command.payload.beforeTaskId ? "beforeTaskId" : "afterTaskId");
      if (command.payload.expectedRevision && board.revision && command.payload.expectedRevision !== board.revision) throw new ApplicationError("CONFLICT", "The board revision is stale.", "expectedRevision", { currentRevision: board.revision });
      return;
    }
    if (command.action !== "assign" && command.action !== "unassign") return;
    const board = await this.repository.readBoard();
    const task = board.tasks.find((item) => item.id === command.payload.taskId);
    if (!task) throw new ApplicationError("NOT_FOUND", "Task not found.", "taskId");
    if (!board.people.some((item) => item.id === command.payload.personId)) throw new ApplicationError("NOT_FOUND", "Person not found.", "personId");
    if (task.workflow.state === "archived") throw new ApplicationError("FORBIDDEN_STATE", "Restore this task before changing assignments.", "taskId");
  }
}

function identifyChanged(command: BoardCommand, board: BoardDto): MutationResult["changed"] {
  if (command.action === "updateFocusSettings") return null;
  if ("id" in command.payload) {
    const changedId = typeof command.payload.id === "string" ? command.payload.id : null;
    if (!changedId) return null;
    if (command.action.includes("Person")) return { kind: "person", id: changedId };
    return { kind: "task", id: changedId };
  }
  if (command.action === "reorderPeople") return { kind: "person", id: command.payload.personId };
  if (command.action === "reorderTasks") return { kind: "task", id: command.payload.taskId };
  if (command.action === "assign" || command.action === "unassign") return { kind: "assignment", id: `${command.payload.taskId}:${command.payload.personId}` };
  if (command.action === "addPerson") return { kind: "person", id: board.people.at(-1)?.id ?? "" };
  if (command.action === "addTask") return { kind: "task", id: board.tasks[0]?.id ?? "" };
  return null;
}
