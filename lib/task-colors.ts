export const TASK_PALETTE_VERSION = 1 as const;

export const TASK_PALETTE = [
  { id: "ocean", value: "#1D4ED8", label: "Ocean", foreground: "#FFFFFF" },
  { id: "indigo", value: "#4338CA", label: "Indigo", foreground: "#FFFFFF" },
  { id: "violet", value: "#6D28D9", label: "Violet", foreground: "#FFFFFF" },
  { id: "orchid", value: "#7E22CE", label: "Orchid", foreground: "#FFFFFF" },
  { id: "berry", value: "#BE185D", label: "Berry", foreground: "#FFFFFF" },
  { id: "brick", value: "#B91C1C", label: "Brick", foreground: "#FFFFFF" },
  { id: "ember", value: "#C2410C", label: "Ember", foreground: "#FFFFFF" },
  { id: "ochre", value: "#A16207", label: "Ochre", foreground: "#FFFFFF" },
  { id: "moss", value: "#3F6212", label: "Moss", foreground: "#FFFFFF" },
  { id: "forest", value: "#047857", label: "Forest", foreground: "#FFFFFF" },
  { id: "lagoon", value: "#0F766E", label: "Lagoon", foreground: "#FFFFFF" },
  { id: "slate", value: "#475569", label: "Slate", foreground: "#FFFFFF" },
] as const;

export type TaskPaletteId = (typeof TASK_PALETTE)[number]["id"];
export type TaskColor = { colorId: TaskPaletteId | null; color: string };

const byId = new Map<string, (typeof TASK_PALETTE)[number]>(TASK_PALETTE.map((item) => [item.id, item]));
const byValue = new Map<string, (typeof TASK_PALETTE)[number]>(TASK_PALETTE.map((item) => [item.value.toLowerCase(), item]));

export function taskPaletteEntry(id: string) { return byId.get(id); }

export function resolveStoredTaskColor(color: string, colorId?: string | null): TaskColor {
  const entry = colorId ? byId.get(colorId) : byValue.get(color.toLowerCase());
  return entry ? { colorId: entry.id, color: entry.value } : { colorId: null, color };
}

/** Active tasks only. Ties are resolved by the published palette order. */
export function allocateTaskColor(tasks: Array<{ color: string; colorId?: string | null; workflow: { state: string } }>): TaskColor {
  const counts = new Map<TaskPaletteId, number>(TASK_PALETTE.map((item) => [item.id, 0]));
  for (const task of tasks) {
    if (task.workflow.state === "archived") continue;
    const resolved = resolveStoredTaskColor(task.color, task.colorId);
    if (resolved.colorId) counts.set(resolved.colorId, (counts.get(resolved.colorId) ?? 0) + 1);
  }
  const selected = TASK_PALETTE.reduce((best, item) => (counts.get(item.id) ?? 0) < (counts.get(best.id) ?? 0) ? item : best);
  return { colorId: selected.id, color: selected.value };
}

export function taskAppearance() {
  return { taskPalette: TASK_PALETTE.map((item) => ({ ...item })), paletteVersion: TASK_PALETTE_VERSION };
}
