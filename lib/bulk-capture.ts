import { z } from "zod";
import { idSchema, taskColorIdSchema, TASK_CATEGORY_MAX_LENGTH, TASK_TITLE_MAX_LENGTH } from "@/lib/domain/contracts";
import { taskPaletteEntry } from "@/lib/task-colors";

export const BULK_SYNTAX_VERSION = "1" as const;
/** Character count, not exact UTF-8 bytes; a generous approximation consistent with other field limits in contracts.ts. */
export const BULK_MAX_TEXT_LENGTH = 256_000;
export const BULK_MAX_ITEMS = 500;

export type BulkIssueCode =
  | "DUPLICATE_LINE" | "UNKNOWN_TAG" | "UNSUPPORTED_DUE_DATE" | "MULTIPLE_CATEGORY_TAGS" | "MULTIPLE_PRIMARY_TAGS"
  | "EMPTY_TITLE" | "TITLE_TOO_LONG" | "CATEGORY_TOO_LONG" | "UNKNOWN_COLOR" | "PERSON_NOT_FOUND" | "PERSON_AMBIGUOUS"
  | "FOCUSED_WITHOUT_PRIMARY" | "ARCHIVED_NOT_SUPPORTED";

export interface BulkIssue { code: BulkIssueCode; message: string; }

export interface BulkParsedItem {
  clientId: string;
  sourceLine: number;
  raw: string;
  title: string;
  category?: string;
  workflowIntent: "unfocused" | "focused";
  primaryPersonId?: string;
  colorId?: string;
  warnings: BulkIssue[];
  errors: BulkIssue[];
}

export interface BulkParseResult {
  syntaxVersion: typeof BULK_SYNTAX_VERSION;
  items: BulkParsedItem[];
  summary: { total: number; valid: number; withWarnings: number; withErrors: number };
}

export interface BulkPersonRef { id: string; name: string; }

/** Input to `BoardService.parseBulkTasks`. Pure parsing depends only on the current people list. */
export const bulkParseInputSchema = z.object({
  text: z.string().max(BULK_MAX_TEXT_LENGTH),
  syntaxVersion: z.literal(BULK_SYNTAX_VERSION).optional(),
}).strict();

/** Input to `BoardService.createBulkTasks`. Only fields the server trusts after re-validating; warnings/errors are preview-only and never submitted. */
export const bulkCreateItemSchema = z.object({
  clientId: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1, "A task title is required.").max(TASK_TITLE_MAX_LENGTH),
  category: z.string().trim().max(TASK_CATEGORY_MAX_LENGTH).optional().default(""),
  primaryPersonId: idSchema.optional(),
  colorId: taskColorIdSchema.optional(),
}).strict();

export const bulkCreateInputSchema = z.object({
  syntaxVersion: z.literal(BULK_SYNTAX_VERSION),
  items: z.array(bulkCreateItemSchema).min(1).max(BULK_MAX_ITEMS),
  mode: z.literal("atomic"),
  expectedRevision: z.string().regex(/^board:[1-9][0-9]*$/).optional(),
  idempotencyKey: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/, "Invalid idempotency key."),
}).strict();

export type BulkCreateInput = z.infer<typeof bulkCreateInputSchema>;

const BULLET_CHARS = new Set(["-", "*", "•"]);
const PRIMARY_PREFIX = "@primary:";
const COLOR_PREFIX = "color:";
const DUE_PREFIX = "due:";

type ClassifiedWord =
  | { kind: "bullet" }
  | { kind: "title"; text: string }
  | { kind: "category"; value: string }
  | { kind: "primary"; value: string }
  | { kind: "color"; value: string }
  | { kind: "due"; value: string }
  | { kind: "flag"; value: string };

function isReservedWord(word: string): boolean {
  const lower = word.toLowerCase();
  return (word.length > 1 && word.startsWith("#"))
    || (word.length > PRIMARY_PREFIX.length && lower.startsWith(PRIMARY_PREFIX))
    || (word.length > 1 && word.startsWith("!"))
    || (word.length > COLOR_PREFIX.length && lower.startsWith(COLOR_PREFIX))
    || (word.length > DUE_PREFIX.length && lower.startsWith(DUE_PREFIX));
}

/** A backslash immediately before a reserved marker keeps it as literal title text, per the documented escaping rule. */
function classify(word: string, isFirstWord: boolean): ClassifiedWord {
  if (word.startsWith("\\") && word.length > 1) {
    const rest = word.slice(1);
    if ((isFirstWord && BULLET_CHARS.has(rest)) || isReservedWord(rest)) return { kind: "title", text: rest };
  }
  if (isFirstWord && BULLET_CHARS.has(word)) return { kind: "bullet" };
  const lower = word.toLowerCase();
  if (word.length > 1 && word.startsWith("#")) return { kind: "category", value: word.slice(1) };
  if (word.length > PRIMARY_PREFIX.length && lower.startsWith(PRIMARY_PREFIX)) return { kind: "primary", value: word.slice(PRIMARY_PREFIX.length) };
  if (word.length > 1 && word.startsWith("!")) return { kind: "flag", value: word.slice(1).toLowerCase() };
  if (word.length > COLOR_PREFIX.length && lower.startsWith(COLOR_PREFIX)) return { kind: "color", value: word.slice(COLOR_PREFIX.length) };
  if (word.length > DUE_PREFIX.length && lower.startsWith(DUE_PREFIX)) return { kind: "due", value: word.slice(DUE_PREFIX.length) };
  return { kind: "title", text: word };
}

function normalizeNameToken(value: string) { return value.toLowerCase().replace(/[^a-z0-9]/g, ""); }

type PersonResolution = { status: "found"; id: string } | { status: "not_found" } | { status: "ambiguous" };

/** Prefer a stable person ID; a normalized (case/punctuation-insensitive) full-name match is a documented convenience. */
function resolvePerson(token: string, people: BulkPersonRef[]): PersonResolution {
  const byId = people.find((person) => person.id === token);
  if (byId) return { status: "found", id: byId.id };
  const normalized = normalizeNameToken(token);
  const matches = people.filter((person) => normalizeNameToken(person.name) === normalized);
  if (matches.length === 1) return { status: "found", id: matches[0].id };
  if (matches.length > 1) return { status: "ambiguous" };
  return { status: "not_found" };
}

function parseLine(raw: string, sourceLine: number, people: BulkPersonRef[]): BulkParsedItem {
  const words = raw.split(/\s+/).filter(Boolean);
  const titleWords: string[] = [];
  const warnings: BulkIssue[] = [];
  const errors: BulkIssue[] = [];
  let category: string | undefined;
  let primaryToken: string | undefined;
  let colorToken: string | undefined;
  let requestedFocused = false;
  let requestedArchived = false;

  words.forEach((word, wordIndex) => {
    const classified = classify(word, wordIndex === 0);
    switch (classified.kind) {
      case "bullet": return;
      case "title": titleWords.push(classified.text); return;
      case "category":
        if (category !== undefined) warnings.push({ code: "MULTIPLE_CATEGORY_TAGS", message: `Multiple #category tags on one line; using "${category}".` });
        else category = classified.value;
        return;
      case "primary":
        if (primaryToken !== undefined) warnings.push({ code: "MULTIPLE_PRIMARY_TAGS", message: `Multiple @primary references on one line; using "${primaryToken}".` });
        else primaryToken = classified.value;
        return;
      case "color": colorToken = classified.value; return;
      case "due": warnings.push({ code: "UNSUPPORTED_DUE_DATE", message: "Due dates are not yet supported by Workgrid and will not be saved." }); return;
      case "flag":
        if (classified.value === "focused") requestedFocused = true;
        else if (classified.value === "archived") requestedArchived = true;
        else warnings.push({ code: "UNKNOWN_TAG", message: `Unknown tag "!${classified.value}"; it will not be saved.` });
        return;
    }
  });

  const title = titleWords.join(" ").trim();
  if (!title) errors.push({ code: "EMPTY_TITLE", message: "The line has no title text after removing tags." });
  else if (title.length > TASK_TITLE_MAX_LENGTH) errors.push({ code: "TITLE_TOO_LONG", message: `Title exceeds ${TASK_TITLE_MAX_LENGTH} characters.` });

  if (category && category.length > TASK_CATEGORY_MAX_LENGTH) errors.push({ code: "CATEGORY_TOO_LONG", message: `Category exceeds ${TASK_CATEGORY_MAX_LENGTH} characters.` });

  let primaryPersonId: string | undefined;
  if (primaryToken) {
    const resolved = resolvePerson(primaryToken, people);
    if (resolved.status === "not_found") errors.push({ code: "PERSON_NOT_FOUND", message: `No person matches "@primary:${primaryToken}".` });
    else if (resolved.status === "ambiguous") errors.push({ code: "PERSON_AMBIGUOUS", message: `"@primary:${primaryToken}" matches more than one person; use their ID instead.` });
    else primaryPersonId = resolved.id;
  }

  let colorId: string | undefined;
  if (colorToken) {
    const entry = taskPaletteEntry(colorToken);
    if (!entry) errors.push({ code: "UNKNOWN_COLOR", message: `"${colorToken}" is not a known task color.` });
    else colorId = entry.id;
  }

  if (requestedArchived) errors.push({ code: "ARCHIVED_NOT_SUPPORTED", message: "Bulk capture cannot create tasks directly into the archived state." });
  if (requestedFocused && !primaryPersonId) errors.push({ code: "FOCUSED_WITHOUT_PRIMARY", message: "\"!focused\" requires a resolvable @primary reference on the same line." });

  return {
    clientId: `line-${sourceLine}`, sourceLine, raw, title, category, primaryPersonId, colorId, warnings, errors,
    workflowIntent: primaryPersonId ? "focused" : "unfocused",
  };
}

/** Pure, deterministic, and locale-independent: identical input and people always produce identical output. Never throws — limits are policy enforced by the caller. */
export function parseBulkCaptureText(text: string, context: { people: BulkPersonRef[] }): BulkParseResult {
  const lines = text.split(/\r\n|\r|\n/);
  const firstSeenAtByLine = new Map<string, number>();
  const items: BulkParsedItem[] = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const sourceLine = index + 1;
    const item = parseLine(trimmed, sourceLine, context.people);
    const dedupeKey = trimmed.toLowerCase();
    const firstSeenAt = firstSeenAtByLine.get(dedupeKey);
    if (firstSeenAt !== undefined) item.warnings.push({ code: "DUPLICATE_LINE", message: `Duplicate of line ${firstSeenAt}.` });
    else firstSeenAtByLine.set(dedupeKey, sourceLine);
    items.push(item);
  });

  return {
    syntaxVersion: BULK_SYNTAX_VERSION,
    items,
    summary: {
      total: items.length,
      valid: items.filter((item) => item.errors.length === 0).length,
      withWarnings: items.filter((item) => item.warnings.length > 0).length,
      withErrors: items.filter((item) => item.errors.length > 0).length,
    },
  };
}
