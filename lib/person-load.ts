import type { AssignmentDto, PersonDto, TaskDto } from "@/lib/domain/contracts";

export const PERSON_LOAD_CALCULATION_VERSION = 1 as const;

export type PersonLoadState = "low" | "balanced" | "overloaded";

export interface PersonLoadPolicy {
  calculationVersion: typeof PERSON_LOAD_CALCULATION_VERSION;
  weights: { primary: number; secondary: number; tertiary: number };
  thresholds: { balancedMinimum: number; overloadedAbove: number };
}

export interface PersonLoadMetric {
  calculationVersion: typeof PERSON_LOAD_CALCULATION_VERSION;
  score: number;
  state: PersonLoadState;
  activeAssignmentCount: number;
  counts: { primary: number; secondary: number; tertiary: number };
}

export const DEFAULT_PERSON_LOAD_POLICY: PersonLoadPolicy = Object.freeze({
  calculationVersion: PERSON_LOAD_CALCULATION_VERSION,
  weights: Object.freeze({ primary: 1, secondary: 0.5, tertiary: 0.25 }),
  thresholds: Object.freeze({ balancedMinimum: 1, overloadedAbove: 2.5 }),
});

export function calculatePersonLoads(
  people: Pick<PersonDto, "id">[],
  tasks: Pick<TaskDto, "id" | "workflow">[],
  assignments: Pick<AssignmentDto, "taskId" | "personId" | "focus">[],
  policy: PersonLoadPolicy = DEFAULT_PERSON_LOAD_POLICY,
): Map<string, PersonLoadMetric> {
  validatePersonLoadPolicy(policy);
  const activeTaskIds = new Set(tasks.filter((task) => task.workflow.state !== "archived").map((task) => task.id));
  const metrics = new Map(people.map((person) => [person.id, emptyMetric(policy)]));
  for (const assignment of assignments) {
    if (!activeTaskIds.has(assignment.taskId)) continue;
    const metric = metrics.get(assignment.personId);
    if (!metric) continue;
    metric.counts[assignment.focus] += 1;
    metric.activeAssignmentCount += 1;
    metric.score += policy.weights[assignment.focus];
  }
  for (const metric of metrics.values()) {
    // The current weights are exactly representable, but rounding keeps future decimal policies stable.
    metric.score = Math.round(metric.score * 1_000_000) / 1_000_000;
    metric.state = metric.score < policy.thresholds.balancedMinimum ? "low"
      : metric.score > policy.thresholds.overloadedAbove ? "overloaded" : "balanced";
  }
  return metrics;
}

export function validatePersonLoadPolicy(policy: PersonLoadPolicy): void {
  const values = [...Object.values(policy.weights), policy.thresholds.balancedMinimum, policy.thresholds.overloadedAbove];
  if (policy.calculationVersion !== PERSON_LOAD_CALCULATION_VERSION || values.some((value) => !Number.isFinite(value) || value < 0)
    || policy.thresholds.balancedMinimum > policy.thresholds.overloadedAbove) {
    throw new Error("Invalid person load policy.");
  }
}

function emptyMetric(policy: PersonLoadPolicy): PersonLoadMetric {
  return { calculationVersion: policy.calculationVersion, score: 0, state: "low", activeAssignmentCount: 0, counts: { primary: 0, secondary: 0, tertiary: 0 } };
}
