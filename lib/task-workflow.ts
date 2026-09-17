export const TERMINAL_OUTCOMES = ["completed", "cancelled", "superseded"] as const;

export type TaskLifecycle = "active" | "archived";
export type WorkflowState = "unfocused" | "focused" | "archived";
export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];
export type LegacyTaskStatus = "active" | "hold" | "archived";

export type WorkflowFacts = {
  lifecycle: TaskLifecycle;
  outcome: TerminalOutcome | null;
  changedAt: string;
  revision: number;
};

export type WorkflowDto = {
  state: WorkflowState;
  outcome?: TerminalOutcome;
  changedAt: string;
};

export class WorkflowError extends Error {
  readonly code: "TASK_ARCHIVED" | "INVALID_OUTCOME" | "REVISION_CONFLICT";

  constructor(
    code: "TASK_ARCHIVED" | "INVALID_OUTCOME" | "REVISION_CONFLICT",
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "WorkflowError";
  }
}

export function workflowDto(facts: WorkflowFacts, primaryCount: number): WorkflowDto {
  if (facts.lifecycle === "archived") {
    return { state: "archived", ...(facts.outcome ? { outcome: facts.outcome } : {}), changedAt: facts.changedAt };
  }
  return { state: primaryCount === 1 ? "focused" : "unfocused", changedAt: facts.changedAt };
}

export function assertAssignable(lifecycle: TaskLifecycle) {
  if (lifecycle === "archived") {
    throw new WorkflowError("TASK_ARCHIVED", "Restore this task before changing assignments.");
  }
}

export function assertRevision(actual: number, expected?: number) {
  if (expected !== undefined && actual !== expected) {
    throw new WorkflowError("REVISION_CONFLICT", `Task revision ${expected} is stale; current revision is ${actual}.`);
  }
}

export function archiveFacts(
  facts: WorkflowFacts,
  outcome: TerminalOutcome | undefined,
  changedAt: string,
  expectedRevision?: number,
): WorkflowFacts {
  assertRevision(facts.revision, expectedRevision);
  return { lifecycle: "archived", outcome: outcome ?? null, changedAt, revision: facts.revision + 1 };
}

export function restoreFacts(facts: WorkflowFacts, changedAt: string, expectedRevision?: number): WorkflowFacts {
  assertRevision(facts.revision, expectedRevision);
  return { lifecycle: "active", outcome: null, changedAt, revision: facts.revision + 1 };
}

export function migrateLegacyStatus(status: LegacyTaskStatus): Pick<WorkflowFacts, "lifecycle" | "outcome"> {
  // `hold` was actionable work without a guaranteed owner, so it becomes active;
  // the presence of a valid primary assignment determines focused/unfocused.
  if (status === "archived") return { lifecycle: "archived", outcome: null };
  return { lifecycle: "active", outcome: null };
}
