import { z } from "zod";

export type CommandId =
  | "palette.open" | "help.open" | "search.focus" | "selection.clear"
  | "task.create" | "task.edit" | "task.delete" | "task.archive" | "task.complete" | "task.restore"
  | "task.moveUp" | "task.moveDown" | "task.moveFirst" | "task.moveLast" | "task.bulkCapture"
  | "person.create" | "person.edit" | "person.delete" | "person.moveUp" | "person.moveDown"
  | "assignment.primary" | "assignment.secondary" | "assignment.tertiary" | "assignment.remove"
  | "view.unfocused" | "view.focused" | "view.archived" | "history.undo";

export type CommandContext = {
  hasTask: boolean; hasPerson: boolean; taskArchived: boolean; canMoveTaskUp: boolean; canMoveTaskDown: boolean;
  canMovePersonUp: boolean; canMovePersonDown: boolean; hasAssignment: boolean; searchActive: boolean;
};

export type CommandAvailability = { enabled: boolean; reason?: string };
export type CommandDefinition = {
  id: CommandId; label: string; group: "Navigation" | "Tasks" | "People" | "Assignments" | "Views";
  help: string; defaultBindings: string[]; destructive?: boolean; serviceAction?: string;
  available: (context: CommandContext) => CommandAvailability;
};

const yes = () => ({ enabled: true });
const needsTask = (c: CommandContext) => c.hasTask ? yes() : { enabled: false, reason: "Select a task first." };
const needsPerson = (c: CommandContext) => c.hasPerson ? yes() : { enabled: false, reason: "Select a person first." };
const activeTask = (c: CommandContext) => !c.hasTask ? { enabled: false, reason: "Select a task first." } : c.taskArchived ? { enabled: false, reason: "Restore the task first." } : yes();

export const COMMAND_REGISTRY: readonly CommandDefinition[] = [
  { id: "palette.open", label: "Open command palette", group: "Navigation", help: "Search and run any command.", defaultBindings: ["mod+k"], available: yes },
  // "?" is what KeyboardEvent.key reports for Shift+/ on a US layout; eventBinding is character-based, so the binding must match the character, not the physical chord.
  { id: "help.open", label: "Open keyboard shortcut help", group: "Navigation", help: "Show shortcuts generated from this registry.", defaultBindings: ["shift+?"], available: yes },
  { id: "search.focus", label: "Search or jump to task/person", group: "Navigation", help: "Focus the board search. The palette also searches people.", defaultBindings: ["/"], available: yes },
  { id: "selection.clear", label: "Clear selection", group: "Navigation", help: "Clear the selected task and person.", defaultBindings: ["escape"], available: yes },
  { id: "task.create", label: "Create task", group: "Tasks", help: "Open the new task editor.", defaultBindings: ["n"], serviceAction: "addTask", available: yes },
  { id: "task.bulkCapture", label: "Bulk capture tasks", group: "Tasks", help: "Paste a list of tasks, preview the parsed result, and create them all at once.", defaultBindings: ["b"], serviceAction: "createBulkTasks", available: yes },
  { id: "task.edit", label: "Edit selected task", group: "Tasks", help: "Open the selected task editor.", defaultBindings: ["e"], serviceAction: "updateTask", available: needsTask },
  { id: "task.archive", label: "Archive selected task", group: "Tasks", help: "Move selected task to archived.", defaultBindings: ["a"], serviceAction: "archiveTask", available: activeTask },
  { id: "task.complete", label: "Complete selected task", group: "Tasks", help: "Archive selected task as completed.", defaultBindings: ["c"], serviceAction: "archiveTask", available: activeTask },
  { id: "task.restore", label: "Restore selected task", group: "Tasks", help: "Restore an archived task.", defaultBindings: ["r"], serviceAction: "restoreTask", available: (c) => !c.hasTask ? { enabled: false, reason: "Select a task first." } : !c.taskArchived ? { enabled: false, reason: "Only archived tasks can be restored." } : yes() },
  { id: "task.delete", label: "Delete selected task", group: "Tasks", help: "Permanently delete after confirmation.", defaultBindings: ["shift+backspace"], destructive: true, serviceAction: "deleteTask", available: needsTask },
  { id: "task.moveUp", label: "Move selected task up", group: "Tasks", help: "Reorder within its workflow list.", defaultBindings: ["alt+arrowup"], serviceAction: "reorderTasks", available: (c) => c.searchActive ? { enabled: false, reason: "Clear search before reordering." } : c.canMoveTaskUp ? yes() : { enabled: false, reason: "Select a task that is not first." } },
  { id: "task.moveDown", label: "Move selected task down", group: "Tasks", help: "Reorder within its workflow list.", defaultBindings: ["alt+arrowdown"], serviceAction: "reorderTasks", available: (c) => c.searchActive ? { enabled: false, reason: "Clear search before reordering." } : c.canMoveTaskDown ? yes() : { enabled: false, reason: "Select a task that is not last." } },
  { id: "task.moveFirst", label: "Move selected task to top", group: "Tasks", help: "Move to the start of its workflow list.", defaultBindings: ["alt+home"], serviceAction: "reorderTasks", available: (c) => c.canMoveTaskUp && !c.searchActive ? yes() : { enabled: false, reason: c.searchActive ? "Clear search before reordering." : "Task is already first or not selected." } },
  { id: "task.moveLast", label: "Move selected task to bottom", group: "Tasks", help: "Move to the end of its workflow list.", defaultBindings: ["alt+end"], serviceAction: "reorderTasks", available: (c) => c.canMoveTaskDown && !c.searchActive ? yes() : { enabled: false, reason: c.searchActive ? "Clear search before reordering." : "Task is already last or not selected." } },
  { id: "person.create", label: "Add person", group: "People", help: "Open the new person editor.", defaultBindings: ["shift+n"], serviceAction: "addPerson", available: yes },
  { id: "person.edit", label: "Edit selected person", group: "People", help: "Open the selected person editor.", defaultBindings: ["shift+e"], serviceAction: "updatePerson", available: needsPerson },
  { id: "person.delete", label: "Remove selected person", group: "People", help: "Permanently remove after confirmation.", defaultBindings: ["mod+shift+backspace"], destructive: true, serviceAction: "deletePerson", available: needsPerson },
  { id: "person.moveUp", label: "Move selected person up", group: "People", help: "Move one row up.", defaultBindings: ["mod+alt+arrowup"], serviceAction: "reorderPeople", available: (c) => c.canMovePersonUp ? yes() : { enabled: false, reason: "Select a person that is not first." } },
  { id: "person.moveDown", label: "Move selected person down", group: "People", help: "Move one row down.", defaultBindings: ["mod+alt+arrowdown"], serviceAction: "reorderPeople", available: (c) => c.canMovePersonDown ? yes() : { enabled: false, reason: "Select a person that is not last." } },
  ...(["primary", "secondary", "tertiary"] as const).map((focus, index): CommandDefinition => ({ id: `assignment.${focus}`, label: `Set ${focus} focus`, group: "Assignments", help: `Assign selected task to selected person as ${focus}.`, defaultBindings: [`mod+${index + 1}`], serviceAction: "assign", available: (c) => !c.hasTask || !c.hasPerson ? { enabled: false, reason: "Select both a task and person." } : c.taskArchived ? { enabled: false, reason: "Restore the task first." } : yes() })),
  { id: "assignment.remove", label: "Remove assignment", group: "Assignments", help: "Unassign selected task from selected person.", defaultBindings: ["mod+0"], serviceAction: "unassign", available: (c) => c.hasAssignment ? yes() : { enabled: false, reason: "The selected task and person are not assigned." } },
  { id: "view.unfocused", label: "Show unfocused tasks", group: "Views", help: "Switch task workflow view.", defaultBindings: ["g u"], available: yes },
  { id: "view.focused", label: "Show focused tasks", group: "Views", help: "Switch task workflow view.", defaultBindings: ["g f"], available: yes },
  { id: "view.archived", label: "Show archived tasks", group: "Views", help: "Switch task workflow view.", defaultBindings: ["g a"], available: yes },
  { id: "history.undo", label: "Undo last mutation", group: "Navigation", help: "Unavailable: the domain service does not yet provide safe undo.", defaultBindings: [], available: () => ({ enabled: false, reason: "Undo is disabled until the application service supports a safe inverse operation." }) },
] as const;

export type BindingMap = Partial<Record<CommandId, string[]>>;
const bindingSchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9+ /]+$/i);
const commandIds = new Set(COMMAND_REGISTRY.map((command) => command.id));

export function parseBindingConfiguration(value: unknown): BindingMap {
  const object = z.record(z.string(), z.array(bindingSchema).max(3)).safeParse(value);
  if (!object.success) throw new Error("Invalid keyboard binding configuration.");
  const result = Object.create(null) as BindingMap;
  for (const [id, bindings] of Object.entries(object.data)) {
    if (!commandIds.has(id as CommandId) || id === "__proto__" || id === "constructor" || id === "prototype") throw new Error(`Unknown command ID: ${id}`);
    result[id as CommandId] = bindings.map(normalizeBinding);
  }
  const conflicts = bindingConflicts(result);
  if (conflicts.length) throw new Error(`Conflicting binding: ${conflicts[0].binding}`);
  return result;
}

export function effectiveBindings(custom: BindingMap, command: CommandDefinition) { return custom[command.id] ?? command.defaultBindings; }
export function bindingConflicts(custom: BindingMap): { binding: string; commandIds: CommandId[] }[] {
  const seen = new Map<string, CommandId[]>();
  for (const command of COMMAND_REGISTRY) for (const binding of effectiveBindings(custom, command)) {
    const key = normalizeBinding(binding); seen.set(key, [...(seen.get(key) ?? []), command.id]);
  }
  return [...seen].filter(([, ids]) => ids.length > 1).map(([binding, commandIds]) => ({ binding, commandIds }));
}
export function normalizeBinding(value: string) { return value.toLowerCase().trim().replace(/\s*\+\s*/g, "+").replace(/\s+/g, " "); }
export function eventBinding(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">) {
  const keys = [event.metaKey || event.ctrlKey ? "mod" : "", event.altKey ? "alt" : "", event.shiftKey ? "shift" : "", event.key.toLowerCase()].filter(Boolean);
  return normalizeBinding(keys.join("+"));
}
export function isTypingTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;
  return Boolean(element?.closest("input, textarea, select, [contenteditable='true'], [role='textbox'], [role='combobox']"));
}
export function filterCommands(query: string) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return COMMAND_REGISTRY;
  return COMMAND_REGISTRY.filter((command) => words.every((word) => `${command.label} ${command.help} ${command.id} ${command.group}`.toLowerCase().includes(word)));
}
export const COMMAND_CAPABILITY_MANIFEST = COMMAND_REGISTRY.map(({ id, label, help, group, serviceAction }) => ({ id, label, help, group, serviceAction: serviceAction ?? null }));

/** Per-browser only. Never synced, never sent to the application service; key bindings are UI metadata, not API state. */
export const BINDINGS_STORAGE_KEY = "workgrid.keyBindings.v1";

export function loadBindings(): BindingMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(BINDINGS_STORAGE_KEY);
    return raw ? parseBindingConfiguration(JSON.parse(raw)) : {};
  } catch { return {}; }
}

export function saveBindings(bindings: BindingMap) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(BINDINGS_STORAGE_KEY, JSON.stringify(bindings)); } catch { /* storage may be unavailable (private mode, quota) */ }
}

export function exportBindings(bindings: BindingMap) { return JSON.stringify(bindings, null, 2); }
