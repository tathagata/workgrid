import assert from "node:assert/strict";
import test from "node:test";
import { BoardService, type BoardRepository } from "../lib/application/board-service";
import { ApplicationError, parseCommand, type BoardCommand, type PersonDto } from "../lib/domain/contracts";
import {
  PEOPLE_PALETTE, PEOPLE_PALETTE_VERSION, allocatePersonColor, peopleAppearance, resolveStoredPersonColor,
} from "../lib/people-colors";

const person = (id: string, color: string, colorId: PersonDto["colorId"] = null): PersonDto =>
  ({ id, name: id, role: "", color, colorId, sortOrder: 0 });

test("people palette is versioned, stable, and has at least twelve accessible choices", () => {
  assert.equal(peopleAppearance().paletteVersion, PEOPLE_PALETTE_VERSION);
  assert.ok(PEOPLE_PALETTE.length >= 12);
  assert.equal(new Set(PEOPLE_PALETTE.map(({ id }) => id)).size, PEOPLE_PALETTE.length);
  assert.equal(new Set(PEOPLE_PALETTE.map(({ value }) => value)).size, PEOPLE_PALETTE.length);
  for (const entry of PEOPLE_PALETTE) assert.ok(contrast(entry.value, entry.foreground) >= 4.5, `${entry.id} must meet WCAG AA contrast`);
});

test("least-used allocation is deterministic across ties, exhaustion, and deletion", () => {
  assert.deepEqual(allocatePersonColor([]), { colorId: PEOPLE_PALETTE[0].id, color: PEOPLE_PALETTE[0].value });
  const onceEach = PEOPLE_PALETTE.map((entry, index) => person(String(index), entry.value, entry.id));
  assert.equal(allocatePersonColor(onceEach).colorId, PEOPLE_PALETTE[0].id, "exhausted palette starts the next balanced cycle");
  assert.equal(allocatePersonColor(onceEach.slice(1)).colorId, PEOPLE_PALETTE[0].id, "deleting a person releases its color");
  assert.equal(allocatePersonColor([person("legacy", "#123456")]).colorId, PEOPLE_PALETTE[0].id, "custom colors do not skew palette counts");
});

test("known legacy values gain identity while custom values remain unchanged", () => {
  assert.deepEqual(resolveStoredPersonColor("#2f6f65"), { colorId: "pine", color: "#2F6F65" });
  assert.deepEqual(resolveStoredPersonColor("#123456"), { colorId: null, color: "#123456" });
});

test("service owns automatic selection and preserves color on update", async () => {
  const people = [person("p1", PEOPLE_PALETTE[0].value, PEOPLE_PALETTE[0].id)];
  const calls: BoardCommand[] = [];
  const repository: BoardRepository = {
    async readBoard() { return { people, tasks: [], assignments: [] }; },
    async execute(command) { calls.push(command); },
  };
  const service = new BoardService(repository);
  await service.execute(parseCommand({ action: "addPerson", payload: { name: "Grace" } }));
  assert.deepEqual(calls[0], { action: "addPerson", payload: { name: "Grace", role: "", colorId: PEOPLE_PALETTE[1].id, color: PEOPLE_PALETTE[1].value } });
  await service.execute(parseCommand({ action: "updatePerson", payload: { id: "p1", name: "Ada" } }));
  assert.deepEqual(calls[1], { action: "updatePerson", payload: { id: "p1", name: "Ada", role: "", colorId: PEOPLE_PALETTE[0].id, color: PEOPLE_PALETTE[0].value } });
  assert.deepEqual(service.getAppearance().peoplePalette, peopleAppearance().peoplePalette);
  assert.equal((await service.getBoard()).appearance.paletteVersion, PEOPLE_PALETTE_VERSION);
});

test("manual IDs work across the shared command parser and invalid colors are stable errors", () => {
  const entry = PEOPLE_PALETTE[3];
  const parsed = parseCommand({ action: "addPerson", payload: { name: "Lin", colorId: entry.id } });
  assert.equal(parsed.action === "addPerson" ? parsed.payload.colorId : null, entry.id);
  assert.throws(() => parseCommand({ action: "addPerson", payload: { name: "Lin", colorId: "not-a-color" } }),
    (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_INPUT" && error.field === "payload.colorId");
  assert.throws(() => parseCommand({ action: "addPerson", payload: { name: "Lin", color: "red" } }),
    (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_INPUT" && error.field === "payload.color");
  assert.throws(() => parseCommand({ action: "addPerson", payload: { name: "Lin", colorId: entry.id, color: "#000000" } }),
    (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_INPUT" && error.field === "payload.color");
});

function contrast(background: string, foreground: string) {
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/../g)!.map((value) => Number.parseInt(value, 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const values = [luminance(background), luminance(foreground)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
