import { CliError, EXIT, usage } from "./errors.js";
import {
  SKILL_AGENTS, SKILL_TARGETS, inspectSkill, installSkill, readBundledSkill, resolveTargets, restoreSkill, snapshotSkill, uninstallSkill, BUNDLED_SKILL_PATH,
} from "./skill.js";

const BOARD_REVISION = /^board:[1-9][0-9]*$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const TASK_STATES = ["unfocused", "focused", "archived"];
const OUTCOMES = ["completed", "cancelled", "superseded"];
const FOCUS = ["primary", "secondary", "tertiary"];

// Reusable option specs.
const boardRevision = { type: "string", value: "board:N", describe: "Fail with CONFLICT unless the board is still at this revision", validate: validateBoardRevision };
const color = { type: "string", value: "HEX", describe: "Six-digit hex color, e.g. #3b82f6" };
const colorId = { type: "string", value: "ID", describe: "Palette color ID (see `workgrid appearance get`)" };
const updateRevision = { ...boardRevision, describe: "Fail with CONFLICT unless the board is still at this revision (default: the revision read just before updating)" };
const yes = { type: "boolean", describe: "Confirm this permanent, destructive action" };
const anchor = (noun) => ({
  before: { type: "string", value: "ID", describe: `Place before this ${noun}`, validate: validateId },
  after: { type: "string", value: "ID", describe: `Place after this ${noun}`, validate: validateId },
  position: { type: "string", values: ["first", "last"], describe: "Place at a list boundary" },
});
const bulkInput = {
  file: { type: "string", value: "PATH", describe: "Read lines from a file instead of stdin (`-` for stdin)" },
  "syntax-version": { type: "string", value: "N", describe: "Bulk syntax version (default: 1)" },
};

/**
 * Every command the CLI understands. This one table drives dispatch, `--help`,
 * shell completion, and the per-command option allowlist.
 */
export const COMMANDS = [
  // ── board ────────────────────────────────────────────────────────────────
  {
    path: ["board", "get"], summary: "Show the whole board (people, tasks, assignments, settings)",
    format: "board",
    run: ({ client }) => client.get(),
  },
  {
    path: ["appearance", "get"], summary: "Show task/people color palettes",
    run: ({ client }) => client.get({ appearance: "1" }),
  },

  // ── people ───────────────────────────────────────────────────────────────
  {
    path: ["people", "list"], summary: "List people in canonical order",
    format: "people",
    run: async ({ client }) => (await client.get()).people ?? [],
  },
  {
    path: ["people", "loads"], summary: "Show each person's workload score and state",
    options: {
      state: { type: "string", values: ["low", "balanced", "overloaded"], describe: "Only people in this load state" },
      sort: { type: "string", values: ["canonical", "highest", "lowest"], describe: "Sort order (default: canonical)" },
    },
    format: (data) => ["people", data.people],
    run: async ({ client, options }) => {
      let people = [...((await client.get()).people ?? [])];
      if (options.state) people = people.filter((person) => person.load?.state === options.state);
      const sort = options.sort ?? "canonical";
      if (sort !== "canonical") people.sort((left, right) => (sort === "highest" ? -1 : 1) * ((left.load?.score ?? 0) - (right.load?.score ?? 0)));
      return { people };
    },
  },
  {
    path: ["people", "create"], summary: "Add a person",
    options: { name: { type: "string", required: true, describe: "Display name" }, role: { type: "string", describe: "Role or title" }, color, "color-id": colorId },
    format: "mutation",
    run: ({ client, options }) => client.post("addPerson", compact({ name: options.name, role: options.role ?? "", color: options.color, colorId: options["color-id"] })),
  },
  {
    path: ["people", "update"], args: ["PERSON_ID"], summary: "Change a person's fields (others are preserved)",
    options: { name: { type: "string", describe: "New display name" }, role: { type: "string", describe: "New role (\"\" clears it)" }, color, "color-id": colorId, "expected-revision": updateRevision },
    requireSomeOption: true,
    format: "mutation",
    run: async ({ client, args: [id], options }) => {
      const board = await client.get();
      const current = board.people?.find((person) => person.id === id);
      if (!current) throw new CliError("NOT_FOUND", `Person ${id} not found.`, EXIT.NOT_FOUND, { field: "id" });
      // Omitted fields are filled from this read, so the write is pinned to its revision: a concurrent edit yields CONFLICT, not a silent overwrite.
      return client.post("updatePerson", compact({
        id, name: options.name ?? current.name, role: options.role ?? current.role ?? "", color: options.color, colorId: options["color-id"], expectedRevision: options["expected-revision"] ?? board.revision,
      }));
    },
  },
  {
    path: ["people", "delete"], args: ["PERSON_ID"], summary: "Permanently delete a person and their assignments",
    options: { yes }, destructive: true,
    format: "mutation",
    run: ({ client, args: [id] }) => client.post("deletePerson", { id }),
  },
  {
    path: ["people", "reorder"], args: ["PERSON_ID"], summary: "Move a person in the canonical order",
    options: { ...anchor("person"), "expected-revision": boardRevision },
    format: "mutation",
    run: ({ client, args: [id], options }) => client.post("reorderPeople", compact({
      personId: id, ...exactlyOneAnchor(options, "Person"), beforePersonId: options.before, afterPersonId: options.after, expectedRevision: options["expected-revision"],
    })),
  },

  // ── tasks ────────────────────────────────────────────────────────────────
  {
    path: ["tasks", "list"], summary: "List tasks, optionally filtered",
    options: {
      state: { type: "string", values: TASK_STATES, describe: "Only tasks in this workflow state" },
      assignee: { type: "string", value: "PERSON_ID", describe: "Only tasks assigned to this person", validate: validateId },
      category: { type: "string", describe: "Only tasks in this exact category" },
    },
    format: (data, board) => ["tasks", data, board],
    run: async ({ client, options, keep }) => {
      const board = await client.get();
      keep(board);
      const assigned = options.assignee ? new Set((board.assignments ?? []).filter((item) => item.personId === options.assignee).map((item) => item.taskId)) : null;
      return (board.tasks ?? []).filter((task) => (!options.state || (task.workflow?.state ?? task.status) === options.state)
        && (options.category === undefined || task.category === options.category)
        && (!assigned || assigned.has(task.id)));
    },
  },
  {
    path: ["tasks", "create"], summary: "Create a task",
    options: { title: { type: "string", required: true, describe: "Task title" }, description: { type: "string", describe: "Longer description" }, category: { type: "string", describe: "Category label" }, color, "color-id": colorId },
    format: "mutation",
    run: ({ client, options }) => client.post("addTask", compact({ title: options.title, description: options.description ?? "", category: options.category ?? "", color: options.color, colorId: options["color-id"] })),
  },
  {
    path: ["tasks", "update"], args: ["TASK_ID"], summary: "Change a task's fields (others are preserved)",
    options: { title: { type: "string", describe: "New title" }, description: { type: "string", describe: "New description (\"\" clears it)" }, category: { type: "string", describe: "New category (\"\" clears it)" }, color, "color-id": colorId, "expected-revision": updateRevision },
    requireSomeOption: true,
    format: "mutation",
    run: async ({ client, args: [id], options }) => {
      const board = await client.get();
      const current = board.tasks?.find((task) => task.id === id);
      if (!current) throw new CliError("NOT_FOUND", `Task ${id} not found.`, EXIT.NOT_FOUND, { field: "id" });
      // Color is omitted unless requested: the service preserves the existing color.
      // Omitted fields are filled from this read, so the write is pinned to its revision: a concurrent edit yields CONFLICT, not a silent overwrite.
      return client.post("updateTask", compact({
        id, title: options.title ?? current.title, description: options.description ?? current.description ?? "", category: options.category ?? current.category ?? "", color: options.color, colorId: options["color-id"], expectedRevision: options["expected-revision"] ?? board.revision,
      }));
    },
  },
  {
    path: ["tasks", "archive"], args: ["TASK_ID"], summary: "Archive a task, optionally recording an outcome",
    options: { outcome: { type: "string", values: OUTCOMES, describe: "Terminal outcome" }, "expected-revision": { type: "string", value: "N", describe: "Fail with CONFLICT unless the task is still at this revision", validate: validatePositiveInteger } },
    format: "mutation",
    run: ({ client, args: [id], options }) => client.post("archiveTask", compact({ id, outcome: options.outcome, expectedRevision: toInteger(options["expected-revision"]) })),
  },
  {
    path: ["tasks", "restore"], args: ["TASK_ID"], summary: "Restore an archived task",
    options: { "expected-revision": { type: "string", value: "N", describe: "Fail with CONFLICT unless the task is still at this revision", validate: validatePositiveInteger } },
    format: "mutation",
    run: ({ client, args: [id], options }) => client.post("restoreTask", compact({ id, expectedRevision: toInteger(options["expected-revision"]) })),
  },
  {
    path: ["tasks", "delete"], args: ["TASK_ID"], summary: "Permanently delete a task (prefer archive)",
    options: { yes }, destructive: true,
    format: "mutation",
    run: ({ client, args: [id] }) => client.post("deleteTask", { id }),
  },
  {
    path: ["tasks", "reorder"], args: ["TASK_ID"], summary: "Move a task within its workflow list",
    options: { state: { type: "string", values: TASK_STATES, required: true, describe: "The list the task is in" }, ...anchor("task"), "expected-revision": boardRevision },
    format: "mutation",
    run: ({ client, args: [id], options }) => client.post("reorderTasks", compact({
      taskId: id, state: options.state, ...exactlyOneAnchor(options, "Task"), beforeTaskId: options.before, afterTaskId: options.after, expectedRevision: options["expected-revision"],
    })),
  },

  // ── assignments & settings ───────────────────────────────────────────────
  {
    path: ["assignments", "set"], args: ["TASK_ID", "PERSON_ID"], summary: "Assign a person to a task (primary replaces the current primary)",
    options: { focus: { type: "string", values: FOCUS, required: true, describe: "Assignment focus" } },
    format: "mutation",
    run: ({ client, args: [taskId, personId], options }) => client.post("assign", { taskId, personId, focus: options.focus }),
  },
  {
    path: ["assignments", "remove"], args: ["TASK_ID", "PERSON_ID"], summary: "Remove a person from a task",
    format: "mutation",
    run: ({ client, args: [taskId, personId] }) => client.post("unassign", { taskId, personId }),
  },
  {
    path: ["settings", "get"], summary: "Show focus-assessment settings",
    run: async ({ client }) => (await client.get()).settings,
  },
  {
    path: ["settings", "update"], summary: "Change the over-focus threshold",
    options: { "overfocus-threshold": { type: "string", value: "NUMBER", required: true, describe: "Weighted load above which a task is over-focused (0.25–100)", validate: validateNumber }, "expected-revision": boardRevision },
    format: "mutation",
    run: ({ client, options }) => client.post("updateFocusSettings", compact({ overfocusThreshold: Number(options["overfocus-threshold"]), expectedRevision: options["expected-revision"] })),
  },

  // ── bulk capture ─────────────────────────────────────────────────────────
  {
    path: ["bulk", "preview"], summary: "Parse task lines (stdin or --file) without creating anything",
    options: bulkInput,
    format: "bulkPreview",
    run: async ({ client, options, readInput }) => client.post("tasks.parseBulk", compact({ text: await readInput(options.file), syntaxVersion: options["syntax-version"] })),
  },
  {
    path: ["bulk", "create"], summary: "Atomically create every line, only if all lines are valid",
    options: { ...bulkInput, "idempotency-key": { type: "string", value: "KEY", required: true, describe: "8–128 letters, digits, _ or -; unique per logical batch; reuse it only to retry the same batch", validate: validateIdempotencyKey }, "expected-revision": boardRevision },
    format: "bulkCreate",
    run: async ({ client, options, readInput }) => {
      const text = await readInput(options.file);
      const preview = await client.post("tasks.parseBulk", compact({ text, syntaxVersion: options["syntax-version"] }));
      if (preview.summary?.withErrors || !preview.items?.length) {
        throw new CliError("BULK_VALIDATION_FAILED", preview.items?.length ? "Bulk input contains invalid lines; run `workgrid bulk preview` for details." : "Bulk input contains no tasks.", EXIT.USAGE, { details: { preview } });
      }
      return client.post("tasks.createBulk", compact({
        syntaxVersion: preview.syntaxVersion,
        items: preview.items.map((item) => compact({ clientId: item.clientId, title: item.title, category: item.category, primaryPersonId: item.primaryPersonId, colorId: item.colorId })),
        mode: "atomic",
        expectedRevision: options["expected-revision"],
        idempotencyKey: options["idempotency-key"],
      }));
    },
  },

  // ── local tooling (no server) ────────────────────────────────────────────
  {
    path: ["doctor"], summary: "Check Node.js, server connectivity, and installed agent skills",
    local: true, needsClient: "optional",
    format: "doctor",
    run: (context) => context.doctor(),
  },
  {
    path: ["skill", "install"], summary: "Install or upgrade the agent skill for Codex, Copilot, or Claude Code",
    local: true,
    options: skillOptions(),
    format: "skill",
    run: async ({ options, paths }) => {
      return applyToSkillTargets(options, paths, installSkill);
    },
  },
  {
    path: ["skill", "uninstall"], summary: "Remove an agent skill this CLI installed",
    local: true,
    options: skillOptions(),
    format: "skill",
    run: async ({ options, paths }) => {
      return applyToSkillTargets(options, paths, uninstallSkill);
    },
  },
  {
    path: ["skill", "status"], summary: "Show where the skill is installed and whether it is current",
    local: true,
    options: { scope: skillOptions().scope },
    run: async ({ options, paths }) => {
      const bundled = await readBundledSkill();
      const targets = [];
      for (const target of resolveTargets("all", options.scope ?? "user", paths)) targets.push({ agent: target.agent, scope: target.scope, path: target.path, state: await inspectSkill(target, bundled) });
      return { bundled: BUNDLED_SKILL_PATH, targets };
    },
  },
  {
    path: ["skill", "show"], summary: "Print the bundled SKILL.md",
    local: true, raw: true,
    run: () => readBundledSkill(),
  },
  {
    path: ["completion"], args: ["SHELL"], summary: "Print a shell completion script (bash, zsh, or fish)",
    local: true, raw: true, argPattern: /^(bash|zsh|fish)$/,
    run: ({ args: [shell], completion }) => completion(shell),
  },
];

/**
 * All-or-nothing across targets: every target is preflighted with a dry run, and if a write still
 * fails part-way (disk full, permissions), targets already changed are restored from snapshots.
 */
async function applyToSkillTargets(options, paths, action) {
  const bundled = await readBundledSkill();
  const targets = resolveTargets(options.agent ?? "agents", options.scope ?? "user", paths);
  const settings = { force: options.force, dryRun: true };
  for (const target of targets) await action(target, bundled, settings);
  if (options["dry-run"]) return { targets: await Promise.all(targets.map((target) => action(target, bundled, settings))) };
  const snapshots = await Promise.all(targets.map((target) => snapshotSkill(target)));
  const results = [];
  try {
    for (const target of targets) results.push(await action(target, bundled, { force: options.force }));
  } catch (caught) {
    const target = targets[results.length];
    const error = caught instanceof CliError ? caught : new CliError("SKILL_WRITE_FAILED", `Could not update ${target.path} (${caught?.code ?? "unknown error"}).`, EXIT.FAILURE);
    const failed = [];
    for (let index = results.length - 1; index >= 0; index -= 1) {
      try { await restoreSkill(targets[index], snapshots[index]); } catch { failed.push(targets[index].path); }
    }
    error.extra = { ...error.extra, details: { ...error.extra?.details, rolledBack: failed.length === 0, ...(failed.length ? { notRestored: failed } : {}) } };
    throw error;
  }
  return { targets: results };
}

function skillOptions() {
  return {
    agent: { type: "string", values: SKILL_AGENTS, describe: `Target agent (default: agents = ${SKILL_TARGETS.agents.label})` },
    scope: { type: "string", values: ["user", "project"], describe: "user = your home directory; project = current directory (default: user)" },
    force: { type: "boolean", describe: "Replace or remove a SKILL.md this CLI did not install" },
    "dry-run": { type: "boolean", describe: "Show what would change without writing" },
  };
}

export function findCommand(positionals) {
  for (const command of COMMANDS) {
    if (command.path.every((part, index) => positionals[index] === part)) return command;
  }
  return null;
}

export function resources() {
  return [...new Set(COMMANDS.map((command) => command.path[0]))];
}

/** Validates options/args against the command spec and returns typed values. */
export function bindCommand(command, positionals, rawOptions) {
  const args = positionals.slice(command.path.length);
  const expected = command.args ?? [];
  if (args.length !== expected.length) {
    throw usage(`Expected ${expected.length ? expected.join(" ") : "no arguments"}; received ${args.length ? args.map((arg) => JSON.stringify(arg)).join(" ") : "none"}.`, { hint: `workgrid ${command.path.join(" ")} --help` });
  }
  for (const arg of args) {
    if (command.argPattern ? !command.argPattern.test(arg) : !IDENTIFIER.test(arg)) throw usage(`Invalid argument ${JSON.stringify(arg)}.`);
  }
  const specs = command.options ?? {};
  const options = Object.create(null);
  for (const [name, value] of Object.entries(rawOptions)) {
    const spec = specs[name];
    if (!spec) throw usage(`Unknown option --${name} for \`workgrid ${command.path.join(" ")}\`.`, { hint: `workgrid ${command.path.join(" ")} --help` });
    if (spec.type === "boolean" && value !== true) throw usage(`--${name} does not accept a value.`);
    if (spec.type === "string" && value === true) throw usage(`--${name} requires a value.`);
    if (spec.values && !spec.values.includes(value)) throw usage(`--${name} must be one of: ${spec.values.join(", ")}.`, { field: name });
    spec.validate?.(value, name);
    options[name] = value;
  }
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.required && (options[name] === undefined || (typeof options[name] === "string" && !options[name].trim()))) throw usage(`--${name} is required.`, { field: name });
  }
  if (command.requireSomeOption && Object.keys(options).length === 0) throw usage("Specify at least one field to update.");
  if (command.destructive && options.yes !== true) {
    throw new CliError("CONFIRMATION_REQUIRED", "This permanent, destructive command requires --yes.", EXIT.USAGE);
  }
  return { args, options };
}

function exactlyOneAnchor(options, label) {
  if ([options.before, options.after, options.position].filter((value) => value !== undefined).length !== 1) {
    throw usage(`${label} reorder requires exactly one of --before, --after, or --position.`);
  }
  return compact({ position: options.position });
}

function validateBoardRevision(value, name) {
  if (!BOARD_REVISION.test(value)) throw usage(`--${name} must look like board:N (read it from \`workgrid board get\`).`, { field: name });
}
function validateId(value, name) {
  if (!IDENTIFIER.test(value)) throw usage(`--${name} must be a Workgrid ID.`, { field: name });
}
function validatePositiveInteger(value, name) {
  if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) throw usage(`--${name} must be a positive integer.`, { field: name });
}
function validateNumber(value, name) {
  if (!/^[0-9]+(\.[0-9]+)?$/.test(value)) throw usage(`--${name} must be a number.`, { field: name });
}
function validateIdempotencyKey(value, name) {
  // Mirrors bulkCreateInputSchema in lib/bulk-capture.ts so a bad key fails before the preview request.
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw usage(`--${name} must be 8–128 characters of letters, digits, _ or -.`, { field: name });
}
function toInteger(value) {
  return value === undefined ? undefined : Number(value);
}

export function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
