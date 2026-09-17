import assert from "node:assert/strict";
import test from "node:test";
import {
  bindingConflicts, COMMAND_REGISTRY, effectiveBindings, eventBinding, exportBindings, filterCommands,
  isTypingTarget, normalizeBinding, parseBindingConfiguration, type CommandContext, type CommandId,
} from "../lib/commands";

const baseContext: CommandContext = {
  hasTask: false, hasPerson: false, taskArchived: false, canMoveTaskUp: false, canMoveTaskDown: false,
  canMovePersonUp: false, canMovePersonDown: false, hasAssignment: false, searchActive: false,
};

function find(id: CommandId) {
  const command = COMMAND_REGISTRY.find((item) => item.id === id);
  assert.ok(command, `${id} missing from the registry`);
  return command!;
}

test("registry includes every operation the keyboard-first issue requires at minimum", () => {
  const required: CommandId[] = [
    "palette.open", "search.focus", "task.create", "task.edit", "task.delete", "task.archive", "task.restore",
    "person.create", "person.edit", "person.delete", "task.moveUp", "person.moveUp", "assignment.primary",
    "assignment.secondary", "assignment.tertiary", "assignment.remove", "view.unfocused", "view.focused",
    "view.archived", "history.undo", "help.open",
  ];
  for (const id of required) find(id);
});

test("destructive commands are flagged so callers always require explicit confirmation", () => {
  assert.equal(find("task.delete").destructive, true);
  assert.equal(find("person.delete").destructive, true);
  assert.notEqual(find("task.archive").destructive, true);
});

test("undo stays disabled until the service supports a safe inverse, with a stated reason", () => {
  const availability = find("history.undo").available(baseContext);
  assert.equal(availability.enabled, false);
  assert.match(availability.reason ?? "", /safe inverse/);
});

test("context-sensitive availability disables commands with a specific, actionable reason", () => {
  assert.equal(find("task.archive").available(baseContext).enabled, false);
  assert.equal(find("task.archive").available({ ...baseContext, hasTask: true, taskArchived: true }).enabled, false);
  assert.equal(find("task.archive").available({ ...baseContext, hasTask: true, taskArchived: false }).enabled, true);

  assert.equal(find("assignment.primary").available(baseContext).enabled, false);
  assert.equal(find("assignment.primary").available({ ...baseContext, hasTask: true, hasPerson: true, taskArchived: true }).enabled, false);
  assert.equal(find("assignment.primary").available({ ...baseContext, hasTask: true, hasPerson: true }).enabled, true);

  assert.equal(find("assignment.remove").available({ ...baseContext, hasAssignment: false }).enabled, false);
  assert.equal(find("assignment.remove").available({ ...baseContext, hasAssignment: true }).enabled, true);

  const moveUp = find("task.moveUp");
  assert.equal(moveUp.available({ ...baseContext, canMoveTaskUp: true }).enabled, true);
  assert.match(moveUp.available({ ...baseContext, canMoveTaskUp: true, searchActive: true }).reason ?? "", /search/i);
});

test("eventBinding is character-based: Shift+/ reports the '?' character, not the physical key", () => {
  assert.equal(eventBinding({ key: "?", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true }), "shift+?");
  assert.equal(eventBinding({ key: "n", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }), "n");
  assert.equal(eventBinding({ key: "N", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true }), "shift+n");
  assert.equal(eventBinding({ key: "1", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }), "mod+1");
  assert.equal(eventBinding({ key: "ArrowUp", metaKey: false, ctrlKey: false, altKey: true, shiftKey: false }), "alt+arrowup");
});

test("help.open's own default binding matches what eventBinding actually produces for '?'", () => {
  const [binding] = find("help.open").defaultBindings;
  assert.equal(binding, eventBinding({ key: "?", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true }));
});

test("isTypingTarget recognizes form controls and assistive widgets, not plain elements", () => {
  // Plain node has no DOM; isTypingTarget checks `instanceof HTMLElement`, so stand up a minimal global for it.
  const previous = (globalThis as Record<string, unknown>).HTMLElement;
  class FakeElement { closest(selector: string) { return selector.includes("input") ? {} : null; } }
  (globalThis as Record<string, unknown>).HTMLElement = FakeElement;
  try {
    const input = new FakeElement();
    const div = new FakeElement(); div.closest = () => null;
    assert.equal(isTypingTarget(input as unknown as HTMLElement), true);
    assert.equal(isTypingTarget(div as unknown as HTMLElement), false);
    assert.equal(isTypingTarget(null), false);
  } finally { (globalThis as Record<string, unknown>).HTMLElement = previous; }
});

test("filterCommands matches on label, help text, group, and ID with all query words required", () => {
  const results = filterCommands("move task");
  assert.ok(results.every((command) => `${command.label} ${command.help} ${command.id} ${command.group}`.toLowerCase().includes("move")));
  assert.ok(results.some((command) => command.id === "task.moveUp"));
  assert.equal(filterCommands("").length, COMMAND_REGISTRY.length);
  assert.equal(filterCommands("no-such-command-xyz").length, 0);
});

test("parseBindingConfiguration rejects unknown command IDs and never pollutes the prototype", () => {
  assert.throws(() => parseBindingConfiguration({ "not.a.command": ["n"] }), /Unknown command ID/);
  assert.throws(() => parseBindingConfiguration({ constructor: ["n"] }), /Unknown command ID/);
  assert.throws(() => parseBindingConfiguration("not an object"), /Invalid keyboard binding configuration/);
  assert.throws(() => parseBindingConfiguration({ "task.create": ["n", "n", "n", "n"] }), /Invalid keyboard binding configuration/);

  // __proto__ only appears as an own enumerable key via JSON.parse (the real import path); as an object-literal
  // key it sets the prototype instead of a property, which would make this a false test of the real attack shape.
  const beforeGetPrototypeOf = Object.getPrototypeOf({});
  const withDangerousKey = JSON.parse('{"__proto__": ["x"], "task.create": ["t"]}');
  const parsed = parseBindingConfiguration(withDangerousKey);
  assert.deepEqual(Object.keys(parsed), ["task.create"]);
  assert.equal(Object.getPrototypeOf({}), beforeGetPrototypeOf);
});

test("parseBindingConfiguration rejects a configuration that creates a binding conflict", () => {
  assert.throws(() => parseBindingConfiguration({ "task.create": ["e"] }), /Conflicting binding/);
});

test("parseBindingConfiguration accepts a valid override and normalizes it", () => {
  const parsed = parseBindingConfiguration({ "task.create": ["Mod + T"] });
  assert.deepEqual(parsed["task.create"], ["mod+t"]);
  assert.equal(normalizeBinding("Mod + T"), "mod+t");
});

test("bindingConflicts reports every command id sharing a binding", () => {
  const conflicts = bindingConflicts({ "task.create": ["e"] });
  assert.ok(conflicts.some((conflict) => conflict.binding === "e" && conflict.commandIds.includes("task.edit") && conflict.commandIds.includes("task.create")));
});

test("effectiveBindings falls back to defaults and custom overrides replace them entirely", () => {
  const command = find("task.create");
  assert.deepEqual(effectiveBindings({}, command), command.defaultBindings);
  assert.deepEqual(effectiveBindings({ "task.create": ["t"] }, command), ["t"]);
});

test("exportBindings round-trips through parseBindingConfiguration", () => {
  const original = { "task.create": ["t"] };
  const roundTripped = parseBindingConfiguration(JSON.parse(exportBindings(original)));
  // parseBindingConfiguration returns a null-prototype object (defense against prototype pollution),
  // so normalize before comparing rather than asserting prototype equality too.
  assert.deepEqual(Object.fromEntries(Object.entries(roundTripped)), original);
});
