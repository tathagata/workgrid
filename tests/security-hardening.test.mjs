import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(new URL("../app/api/board/route.ts", import.meta.url), "utf8");
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
const contracts = await readFile(new URL("../lib/domain/contracts.ts", import.meta.url), "utf8");

test("board writes enforce request and field limits", () => {
  assert.match(route, /MAX_BODY_BYTES = 16 \* 1024/);
  assert.match(route, /executeHttpBoardCommand\(service\(\), input\)/);
  assert.match(contracts, /z\.discriminatedUnion\("action"/);
  assert.match(contracts, /description: optionalText\(2_000\)/);
  assert.match(route, /PAYLOAD_TOO_LARGE[\s\S]*413/);
});

test("internal errors are not returned to clients", () => {
  assert.doesNotMatch(route, /error instanceof Error \? error\.message/);
  assert.match(route, /console\.error\("Could not save that change\."/);
});

test("the empty board is not populated with demo employees", () => {
  assert.doesNotMatch(route, /seedIfEmpty|Alex Rivera|Priya Nair/);
});

test("local-only deployment and UI language stay explicit", () => {
  assert.match(compose, /127\.0\.0\.1:4173:4173/);
  assert.match(page, /Saved locally/);
  assert.doesNotMatch(page, /Saved privately|Internal only/);
});
