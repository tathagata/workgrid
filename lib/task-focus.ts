import type { AssignmentDto } from "@/lib/domain/contracts";

export const FOCUS_ASSESSMENT_VERSION = 1 as const;
export const DEFAULT_OVERFOCUS_THRESHOLD = 2.5;
export const MIN_OVERFOCUS_THRESHOLD = 0.25;
export const MAX_OVERFOCUS_THRESHOLD = 100;
export const FOCUS_WEIGHTS = Object.freeze({ primary: 1 as const, secondary: 0.5 as const, tertiary: 0.25 as const });

export type FocusAssessment = {
  version: typeof FOCUS_ASSESSMENT_VERSION;
  state: "unfocused" | "focused" | "overfocused";
  primaryCount: number; secondaryCount: number; tertiaryCount: number;
  weightedLoad: number; threshold: number;
};

export function assessTaskFocus(assignments: Pick<AssignmentDto, "focus">[], threshold: number): FocusAssessment {
  const primaryCount = assignments.filter((item) => item.focus === "primary").length;
  const secondaryCount = assignments.filter((item) => item.focus === "secondary").length;
  const tertiaryCount = assignments.filter((item) => item.focus === "tertiary").length;
  const weightedLoad = primaryCount + secondaryCount * 0.5 + tertiaryCount * 0.25;
  return { version: FOCUS_ASSESSMENT_VERSION, state: primaryCount === 0 ? "unfocused" : weightedLoad > threshold ? "overfocused" : "focused", primaryCount, secondaryCount, tertiaryCount, weightedLoad, threshold };
}
