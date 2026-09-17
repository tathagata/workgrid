import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ApplicationError } from "../lib/domain/contracts";
import { CliBackupService } from "../lib/persistence/cli-backup-service";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workgrid-cli-backup-"));
  const databasePath = join(root, "board.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA user_version=3; CREATE TABLE people(id TEXT PRIMARY KEY, name TEXT); INSERT INTO people VALUES('p1','Ada')");
  db.close();
  const service = new CliBackupService({ databasePath, dataRoot: root, backupPath: join(root, "backups") });
  return { root, databasePath, service };
}

test("creates, lists, verifies, and restores through the shared service contract", async () => {
  const f = fixture();
  try {
    const { backupId } = await f.service.create({ reason: "manual" });
    const listed = await f.service.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, backupId);

    const verified = await f.service.verify({ backupId });
    assert.equal(verified.id, backupId);

    const db = new DatabaseSync(f.databasePath);
    db.exec("UPDATE people SET name='Grace'");
    db.close();

    await f.service.restore({ backupId, confirmation: `RESTORE:${backupId}` });
    const restored = new DatabaseSync(f.databasePath, { readOnly: true });
    assert.equal(restored.prepare("SELECT name FROM people").get()?.name, "Ada");
    restored.close();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("rejects a malformed backup ID before shelling out", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.service.verify({ backupId: "../../etc/passwd" }), (error: unknown) => {
      assert.ok(error instanceof ApplicationError);
      assert.equal(error.code, "INVALID_INPUT");
      return true;
    });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("refuses to delete the last known-good backup with a forbidden-state error", async () => {
  const f = fixture();
  try {
    const { backupId } = await f.service.create({ reason: "manual" });
    await assert.rejects(f.service.delete({ backupId }), (error: unknown) => {
      assert.ok(error instanceof ApplicationError);
      assert.equal(error.code, "FORBIDDEN_STATE");
      return true;
    });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("surfaces a stale expected revision as a conflict", async () => {
  const f = fixture();
  try {
    const { backupId } = await f.service.create({ reason: "manual" });
    await assert.rejects(f.service.restore({ backupId, confirmation: `RESTORE:${backupId}`, expectedCurrentRevision: "stale" }), (error: unknown) => {
      assert.ok(error instanceof ApplicationError);
      assert.equal(error.code, "CONFLICT");
      return true;
    });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("never leaks local filesystem paths in error messages", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.service.verify({ backupId: "20260101T000000Z-missing-deadbeef" }), (error: unknown) => {
      assert.ok(error instanceof ApplicationError);
      assert.doesNotMatch(error.message, /\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/);
      return true;
    });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
