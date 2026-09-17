import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("people color migration preserves custom values and only adds identity", async () => {
  const sql = await readFile(new URL("../drizzle/0005_people_colors.sql", import.meta.url), "utf8");
  assert.match(sql, /ALTER TABLE `people` ADD `color_id` text/);
  assert.match(sql, /ELSE NULL END/);
  assert.doesNotMatch(sql, /UPDATE `people` SET `color`/);
});
