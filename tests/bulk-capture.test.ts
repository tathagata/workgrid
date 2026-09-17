import assert from "node:assert/strict";
import test from "node:test";
import { parseBulkCaptureText, type BulkPersonRef } from "../lib/bulk-capture";

const people: BulkPersonRef[] = [
  { id: "p-alex", name: "Alex Rivera" }, { id: "p-ada", name: "Ada Lovelace" },
  { id: "p-sam1", name: "Sam Lee" }, { id: "p-sam2", name: "Sam Lee" },
];

function parse(text: string) { return parseBulkCaptureText(text, { people }); }
function only(text: string) { const result = parse(text); assert.equal(result.items.length, 1, `expected exactly one parsed item for ${JSON.stringify(text)}`); return result.items[0]; }

test("parses the documented example grammar end to end", () => {
  const result = parse([
    "- Investigate API latency #performance @primary:alex-rivera !focused color:lagoon",
    "- Prepare release notes #release",
    "- Replace deprecated runner due:2026-10-15",
  ].join("\n"));
  assert.equal(result.summary.total, 3);

  const [first, second, third] = result.items;
  assert.equal(first.title, "Investigate API latency");
  assert.equal(first.category, "performance");
  assert.equal(first.primaryPersonId, "p-alex");
  assert.equal(first.workflowIntent, "focused");
  assert.equal(first.errors.length, 0);

  assert.equal(second.title, "Prepare release notes");
  assert.equal(second.category, "release");
  assert.equal(second.workflowIntent, "unfocused");

  assert.equal(third.title, "Replace deprecated runner");
  assert.equal(third.workflowIntent, "unfocused");
  assert.equal(third.errors.length, 0);
  assert.deepEqual(third.warnings.map((w) => w.code), ["UNSUPPORTED_DUE_DATE"]);
});

test("an unknown color ID is reported, not silently dropped or substituted", () => {
  const item = only("Investigate API latency color:teal");
  assert.deepEqual(item.errors.map((e) => e.code), ["UNKNOWN_COLOR"]);
});

test("all three bullet styles are optional and interchangeable", () => {
  for (const bullet of ["-", "*", "•"]) {
    const item = only(`${bullet} Ship it`);
    assert.equal(item.title, "Ship it");
  }
});

test("blank lines are skipped and never become items", () => {
  const result = parse("Task one\n\n   \nTask two");
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].sourceLine, 1);
  assert.equal(result.items[1].sourceLine, 4);
});

test("a line with only tags and no title text is an error, not a silently-dropped item", () => {
  const item = only("#release @primary:p-ada");
  assert.deepEqual(item.errors.map((e) => e.code), ["EMPTY_TITLE"]);
});

test("resolves a primary reference by stable ID or by normalized, punctuation-insensitive name", () => {
  assert.equal(only("Ship it @primary:p-ada").primaryPersonId, "p-ada");
  assert.equal(only("Ship it @primary:AdaLovelace").primaryPersonId, "p-ada");
  assert.equal(only("Ship it @primary:ada-lovelace").primaryPersonId, "p-ada");
});

test("an unresolvable or ambiguous primary reference is a distinct, actionable error", () => {
  assert.deepEqual(only("Ship it @primary:nobody").errors.map((e) => e.code), ["PERSON_NOT_FOUND"]);
  assert.deepEqual(only("Ship it @primary:sam-lee").errors.map((e) => e.code), ["PERSON_AMBIGUOUS"]);
});

test("!focused without a resolvable primary is an error; archived is always rejected", () => {
  assert.deepEqual(only("Ship it !focused").errors.map((e) => e.code), ["FOCUSED_WITHOUT_PRIMARY"]);
  assert.deepEqual(only("Ship it !archived").errors.map((e) => e.code), ["ARCHIVED_NOT_SUPPORTED"]);
  assert.equal(only("Ship it @primary:p-ada !focused").workflowIntent, "focused");
});

test("a resolved primary implies focused even without an explicit !focused marker", () => {
  assert.equal(only("Ship it @primary:p-ada").workflowIntent, "focused");
});

test("an unrecognized !flag is a recoverable warning, never a silent drop", () => {
  const item = only("Ship it !urgent");
  assert.deepEqual(item.warnings.map((w) => w.code), ["UNKNOWN_TAG"]);
  assert.equal(item.title, "Ship it");
});

test("duplicate lines are flagged on every repeat, not silently merged into one item", () => {
  const result = parse("Ship it\nShip it\nShip it");
  assert.equal(result.items.length, 3);
  assert.deepEqual(result.items[0].warnings, []);
  assert.deepEqual(result.items[1].warnings.map((w) => w.code), ["DUPLICATE_LINE"]);
  assert.deepEqual(result.items[2].warnings.map((w) => w.code), ["DUPLICATE_LINE"]);
});

test("duplicate detection is case- and whitespace-insensitive but reports the true first line", () => {
  const result = parse("Ship It\n  ship it  ");
  assert.equal(result.items[1].warnings[0]?.message, "Duplicate of line 1.");
});

test("a backslash escapes a leading bullet or a mid-line reserved marker into literal title text", () => {
  assert.equal(only("\\- Not a bullet").title, "- Not a bullet");
  assert.equal(only("Say \\#winning").title, "Say #winning");
  assert.equal(only("Reach \\@primary:someone for help").title, "Reach @primary:someone for help");
  assert.equal(only("Say \\!wow").title, "Say !wow");
  assert.equal(only("Set \\color:blue as a literal phrase").title, "Set color:blue as a literal phrase");
});

test("multiple category or primary tags on one line keep the first and warn about the rest", () => {
  const withTwoCategories = only("Ship it #release #hotfix");
  assert.equal(withTwoCategories.category, "release");
  assert.deepEqual(withTwoCategories.warnings.map((w) => w.code), ["MULTIPLE_CATEGORY_TAGS"]);

  const withTwoPrimaries = only("Ship it @primary:p-ada @primary:p-alex-rivera");
  assert.equal(withTwoPrimaries.primaryPersonId, "p-ada");
  assert.deepEqual(withTwoPrimaries.warnings.map((w) => w.code), ["MULTIPLE_PRIMARY_TAGS"]);
});

test("oversized titles and categories are errors with the field named", () => {
  const longTitle = only(`${"x".repeat(201)}`);
  assert.deepEqual(longTitle.errors.map((e) => e.code), ["TITLE_TOO_LONG"]);
  const longCategory = only(`Ship it #${"y".repeat(101)}`);
  assert.deepEqual(longCategory.errors.map((e) => e.code), ["CATEGORY_TOO_LONG"]);
});

test("parsing is deterministic: identical input and people always produce identical output", () => {
  const text = "- Investigate API latency #performance @primary:p-ada !focused color:forest\nDuplicate line\nDuplicate line";
  assert.deepEqual(parse(text), parse(text));
});

test("client IDs are stable and derived from source line, not insertion order into a map", () => {
  const result = parse("First\nSecond\nThird");
  assert.deepEqual(result.items.map((item) => item.clientId), ["line-1", "line-2", "line-3"]);
});

test("summary counts total, valid, warned, and errored items independently", () => {
  const result = parse("Clean task\nShip it !archived\nShip it !urgent\nShip it !urgent");
  assert.deepEqual(result.summary, { total: 4, valid: 3, withWarnings: 2, withErrors: 1 });
});
