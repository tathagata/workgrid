import { z } from "zod";
import { TASK_PALETTE, taskPaletteEntry } from "@/lib/task-colors";
import { PEOPLE_PALETTE, peoplePaletteEntry } from "@/lib/people-colors";
import type { FocusAssessment } from "@/lib/task-focus";
import { MAX_OVERFOCUS_THRESHOLD, MIN_OVERFOCUS_THRESHOLD } from "@/lib/task-focus";
import type { PersonLoadMetric, PersonLoadPolicy } from "@/lib/person-load";

export const API_VERSION = 1 as const;
export const MAX_PAGE_SIZE = 200;
export const TASK_TITLE_MAX_LENGTH = 200;
export const TASK_CATEGORY_MAX_LENGTH = 100;

export const idSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "Invalid identifier.");
export const colorSchema = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Invalid color.");
export const taskColorIdSchema = z.enum(TASK_PALETTE.map((item) => item.id) as [typeof TASK_PALETTE[number]["id"], ...typeof TASK_PALETTE[number]["id"][]]);
export const peopleColorIdSchema = z.enum(PEOPLE_PALETTE.map((item) => item.id) as [typeof PEOPLE_PALETTE[number]["id"], ...typeof PEOPLE_PALETTE[number]["id"][]]);
export const focusSchema = z.enum(["primary", "secondary", "tertiary"]);
export const terminalOutcomeSchema = z.enum(["completed", "cancelled", "superseded"]);
export const boardRevisionSchema = z.string().regex(/^board:[1-9][0-9]*$/, "Invalid board revision.");

export const reorderPersonPayloadSchema = z.object({
  personId: idSchema,
  beforePersonId: idSchema.optional(),
  afterPersonId: idSchema.optional(),
  position: z.enum(["first", "last"]).optional(),
  expectedRevision: boardRevisionSchema.optional(),
}).strict().superRefine((value, context) => {
  const targets = [value.beforePersonId, value.afterPersonId, value.position].filter(Boolean);
  if (targets.length !== 1) context.addIssue({ code: z.ZodIssueCode.custom, message: "Specify exactly one of beforePersonId, afterPersonId, or position." });
  if (value.beforePersonId === value.personId || value.afterPersonId === value.personId) context.addIssue({ code: z.ZodIssueCode.custom, message: "A person cannot be positioned relative to themselves.", path: ["personId"] });
});

export const workflowStateSchema = z.enum(["unfocused", "focused", "archived"]);
export const reorderTaskPayloadSchema = z.object({
  taskId: idSchema,
  state: workflowStateSchema,
  beforeTaskId: idSchema.optional(),
  afterTaskId: idSchema.optional(),
  position: z.enum(["first", "last"]).optional(),
  expectedRevision: boardRevisionSchema.optional(),
}).strict().superRefine((value, context) => {
  const targets = [value.beforeTaskId, value.afterTaskId, value.position].filter(Boolean);
  if (targets.length !== 1) context.addIssue({ code: z.ZodIssueCode.custom, message: "Specify exactly one of beforeTaskId, afterTaskId, or position." });
  if (value.beforeTaskId === value.taskId || value.afterTaskId === value.taskId) context.addIssue({ code: z.ZodIssueCode.custom, message: "A task cannot be positioned relative to itself.", path: ["taskId"] });
});

const requiredText = (label: string, max: number) => z.string().trim().min(1, `${label} is required.`).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional().default("");

export const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("addPerson"), payload: personInputSchema(false) }),
  z.object({ action: z.literal("updatePerson"), payload: personInputSchema(true) }),
  z.object({ action: z.literal("deletePerson"), payload: z.object({ id: idSchema }).strict() }),
  z.object({ action: z.literal("reorderPeople"), payload: reorderPersonPayloadSchema }),
  z.object({ action: z.literal("addTask"), payload: taskInputSchema(false) }),
  z.object({ action: z.literal("updateTask"), payload: taskInputSchema(true) }),
  z.object({ action: z.literal("archiveTask"), payload: z.object({ id: idSchema, outcome: terminalOutcomeSchema.optional(), expectedRevision: z.number().int().positive().optional() }).strict() }),
  z.object({ action: z.literal("restoreTask"), payload: z.object({ id: idSchema, expectedRevision: z.number().int().positive().optional() }).strict() }),
  z.object({ action: z.literal("reorderTasks"), payload: reorderTaskPayloadSchema }),
  z.object({ action: z.literal("deleteTask"), payload: z.object({ id: idSchema }).strict() }),
  z.object({ action: z.literal("assign"), payload: z.object({ taskId: idSchema, personId: idSchema, focus: focusSchema }).strict() }),
  z.object({ action: z.literal("unassign"), payload: z.object({ taskId: idSchema, personId: idSchema }).strict() }),
  z.object({ action: z.literal("updateFocusSettings"), payload: z.object({ overfocusThreshold: z.number().finite().min(MIN_OVERFOCUS_THRESHOLD).max(MAX_OVERFOCUS_THRESHOLD), expectedRevision: boardRevisionSchema.optional() }).strict() }),
]);

export type BoardCommand = z.infer<typeof commandSchema>;
export type Focus = z.infer<typeof focusSchema>;

export interface PersonDto {
  id: string;
  name: string;
  role: string;
  color: string;
  colorId: z.infer<typeof peopleColorIdSchema> | null;
  sortOrder: number;
  /** Derived by BoardService. Persistence adapters do not store this value. */
  load?: PersonLoadMetric;
}

export interface TaskDto {
  id: string;
  title: string;
  description: string;
  category: string;
  color: string;
  colorId: z.infer<typeof taskColorIdSchema> | null;
  workflow: { state: "unfocused" | "focused" | "archived"; outcome?: "completed" | "cancelled" | "superseded"; changedAt: string };
  createdAt: string;
  updatedAt: string;
  revision: number;
  sortOrder: number;
  focusAssessment?: FocusAssessment | null;
}

function taskInputSchema(includeId: boolean) {
  return z.object({
    ...(includeId ? { id: idSchema } : {}),
    title: requiredText("A task title", TASK_TITLE_MAX_LENGTH), description: optionalText(2_000), category: optionalText(TASK_CATEGORY_MAX_LENGTH),
    color: colorSchema.optional(), colorId: taskColorIdSchema.optional(),
  }).strict().superRefine((value, context) => {
    if (!value.color || !value.colorId) return;
    if (taskPaletteEntry(value.colorId)?.value.toLowerCase() !== value.color.toLowerCase()) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["color"], message: "Color does not match the selected palette ID." });
    }
  });
}

export interface AssignmentDto {
  id: string;
  taskId: string;
  personId: string;
  focus: Focus;
  createdAt: string;
}

export interface BoardDto {
  apiVersion: typeof API_VERSION;
  people: PersonDto[];
  tasks: TaskDto[];
  assignments: AssignmentDto[];
  revision: string;
  savedAt: string;
  appearance: { paletteVersion: number };
  settings: { focusAssessmentVersion: 1; overfocusThreshold: number; weights: { primary: 1; secondary: 0.5; tertiary: 0.25 } };
  workload: PersonLoadPolicy;
}

export type ErrorCode = "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "FORBIDDEN_STATE" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED" | "INTERNAL";

export class ApplicationError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly field?: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ApplicationError";
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.field ? { field: this.field } : {}), ...(this.details ? { details: this.details } : {}) };
  }
}

export function parseCommand(value: unknown): BoardCommand {
  const parsed = commandSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApplicationError("INVALID_INPUT", issue?.message ?? "Invalid request.", issue?.path.join("."));
  }
  return parsed.data;
}

function personInputSchema(includeId: boolean) {
  return z.object({
    ...(includeId ? { id: idSchema } : {}),
    name: requiredText("A name", 100), role: optionalText(160),
    color: colorSchema.optional(), colorId: peopleColorIdSchema.optional(),
  }).strict().superRefine((value, context) => {
    if (!value.color || !value.colorId) return;
    if (peoplePaletteEntry(value.colorId)?.value.toLowerCase() !== value.color.toLowerCase()) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["color"], message: "Color does not match the selected palette ID." });
    }
  });
}
