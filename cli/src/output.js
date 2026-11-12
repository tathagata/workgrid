/**
 * Output rendering. Board content (titles, names, roles, server messages) is untrusted:
 * a task titled "\x1b]52;c;..." must never reach a terminal as a live escape sequence.
 * JSON output escapes C0/C1 controls and bidi overrides; text output strips them.
 */

// C0 (except \t \n), DEL, C1, and Unicode bidi/format controls used in "Trojan Source" style spoofing.
const UNSAFE_TEXT = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// Same set, for JSON: C0 is already escaped by JSON.stringify.
const UNSAFE_JSON = /[\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g;

export function sanitizeText(value) {
  return String(value ?? "").replace(UNSAFE_TEXT, "\ufffd");
}

export function toJson(value, pretty) {
  return JSON.stringify(value, null, pretty ? 2 : 0)
    .replace(UNSAFE_JSON, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function createStyle(enabled) {
  const wrap = (open, close) => (text) => (enabled ? `\x1b[${open}m${text}\x1b[${close}m` : String(text));
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
  };
}

/** Color only for an interactive terminal, honoring https://no-color.org and FORCE_COLOR. */
export function colorEnabled(stream, env) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  return Boolean(stream?.isTTY) && env.TERM !== "dumb";
}

function displayWidth(text) {
  // Good enough for a table: count code points, not UTF-16 units.
  return [...text].length;
}

function truncate(text, max) {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** Renders rows as an aligned table. Every cell is sanitized. */
export function table(columns, rows, style, { maxCell = 60 } = {}) {
  if (rows.length === 0) return style.dim("(none)");
  const cells = rows.map((row) => columns.map((column) => truncate(sanitizeText(column.value(row)), column.max ?? maxCell)));
  const widths = columns.map((column, index) => Math.max(displayWidth(column.label), ...cells.map((row) => displayWidth(row[index]))));
  const pad = (text, width) => text + " ".repeat(Math.max(0, width - displayWidth(text)));
  const header = columns.map((column, index) => style.bold(pad(column.label, widths[index]))).join("  ");
  const body = cells.map((row) => row.map((cell, index) => {
    const padded = index === row.length - 1 ? cell : pad(cell, widths[index]);
    const paint = columns[index].paint && style[columns[index].paint(cell)];
    return paint ? paint(padded) : padded;
  }).join("  "));
  return [header.trimEnd(), ...body.map((line) => line.trimEnd())].join("\n");
}

const LOAD_STYLE = { low: "dim", balanced: "green", overloaded: "red" };
const FOCUS_STYLE = { unfocused: "yellow", focused: "green", overfocused: "red" };

export const formatters = {
  board(board, style) {
    const people = board.people ?? [];
    const tasks = board.tasks ?? [];
    const active = tasks.filter((task) => task.workflow?.state !== "archived");
    return [
      `${style.bold("Workgrid")} ${style.dim(`revision ${sanitizeText(board.revision)} · ${people.length} people · ${active.length} active tasks · ${tasks.length - active.length} archived`)}`,
      "",
      style.bold("People"),
      formatters.people(people, style),
      "",
      style.bold("Active tasks"),
      formatters.tasks(active, style, board),
    ].join("\n");
  },

  people(people, style) {
    return table([
      { label: "ID", value: (person) => person.id },
      { label: "NAME", value: (person) => person.name },
      { label: "ROLE", value: (person) => person.role || "—", max: 32 },
      { label: "LOAD", value: (person) => person.load?.score ?? "—" },
      { label: "STATE", value: (person) => person.load?.state ?? "—", paint: (state) => LOAD_STYLE[state] },
    ], people, style);
  },

  tasks(tasks, style, board) {
    const owners = new Map();
    for (const assignment of board?.assignments ?? []) {
      if (assignment.focus !== "primary") continue;
      const person = board.people?.find((candidate) => candidate.id === assignment.personId);
      if (person) owners.set(assignment.taskId, person.name);
    }
    const columns = [
      { label: "ID", value: (task) => task.id },
      { label: "STATE", value: (task) => task.workflow?.state ?? task.status ?? "—" },
      { label: "FOCUS", value: (task) => task.focusAssessment?.state ?? "—", paint: (state) => FOCUS_STYLE[state] },
      { label: "CATEGORY", value: (task) => task.category || "—", max: 24 },
      ...(board ? [{ label: "OWNER", value: (task) => owners.get(task.id) ?? "—", max: 24 }] : []),
      { label: "TITLE", value: (task) => task.title },
    ];
    return table(columns, tasks, style);
  },

  mutation(result, style) {
    const changed = result?.changed;
    const revision = result?.board?.revision ?? result?.revision;
    const what = changed ? `${changed.kind} ${sanitizeText(changed.id)}` : "board";
    return `${style.green("✓")} Updated ${what}${revision ? style.dim(` (revision ${sanitizeText(revision)})`) : ""}`;
  },

  bulkPreview(preview, style) {
    const summary = preview.summary ?? {};
    const lines = table([
      { label: "LINE", value: (item) => item.sourceLine ?? "" },
      { label: "STATUS", value: (item) => (item.errors?.length ? "error" : item.warnings?.length ? "warning" : "ok"), paint: (state) => ({ error: "red", warning: "yellow", ok: "green" })[state] },
      { label: "TITLE", value: (item) => item.title || "—", max: 48 },
      { label: "ISSUES", value: (item) => [...(item.errors ?? []), ...(item.warnings ?? [])].map((issue) => issue.code).join(", ") || "—" },
    ], preview.items ?? [], style);
    return `${lines}\n\n${summary.total ?? 0} lines · ${style.green(`${summary.valid ?? 0} valid`)} · ${style.yellow(`${summary.withWarnings ?? 0} with warnings`)} · ${style.red(`${summary.withErrors ?? 0} with errors`)}`;
  },

  bulkCreate(result, style) {
    return `${style.green("✓")} Created ${result.created?.length ?? 0} tasks${result.revision ? style.dim(` (revision ${sanitizeText(result.revision)})`) : ""}`;
  },

  doctor(report, style) {
    const icon = { pass: style.green("✓"), warn: style.yellow("!"), fail: style.red("✗") };
    return report.checks.map((check) => `${icon[check.status]} ${sanitizeText(check.name)}: ${sanitizeText(check.detail)}`).join("\n");
  },

  skill(result, style) {
    const verb = { installed: "Installed", updated: "Updated", unchanged: "Already current", removed: "Removed", absent: "Not installed", "would-install": "Would install", "would-update": "Would update", "would-remove": "Would remove" };
    return result.targets.map((target) => `${style.green("✓")} ${verb[target.status] ?? target.status} ${style.bold(target.agent)} skill ${style.dim(target.path)}`).join("\n");
  },

  /** Fallback for anything without a dedicated formatter. */
  json(value) {
    return toJson(value, true);
  },
};

export function formatError(error, style) {
  const lines = [`${style.red("error")} ${style.dim(`[${error.code}]`)} ${sanitizeText(error.message)}`];
  if (error.field) lines.push(`  ${style.dim("field:")} ${sanitizeText(error.field)}`);
  if (error.details) lines.push(`  ${style.dim("details:")} ${sanitizeText(toJson(error.details, false))}`);
  if (error.hint) lines.push(`  ${style.dim("hint:")} ${sanitizeText(error.hint)}`);
  return lines.join("\n");
}
