import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { resolveLocalDatabasePath } from "../mcp/sqlite-database.ts";

test("resolveLocalDatabasePath ignores Miniflare's own metadata.sqlite registry and finds the real database", () => {
  const root = mkdtempSync(join(tmpdir(), "workgrid-mcp-db-"));
  try {
    const d1Dir = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
    mkdirSync(d1Dir, { recursive: true });
    new DatabaseSync(join(d1Dir, "metadata.sqlite")).close();
    const real = join(d1Dir, "abcdef0123456789.sqlite");
    new DatabaseSync(real).close();

    assert.equal(resolveLocalDatabasePath(root), realpathSync(real));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
