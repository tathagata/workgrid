import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const script = new URL("../scripts/backup-manager.mjs", import.meta.url).pathname;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workgrid-backup-"));
  const database = join(root, "board.sqlite");
  const backups = join(root, "backups");
  const db = new DatabaseSync(database);
  db.exec("PRAGMA user_version=3; CREATE TABLE people(id TEXT PRIMARY KEY, name TEXT); CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT, status TEXT, color TEXT, sort_order INTEGER); CREATE TABLE assignments(id TEXT, task_id TEXT, person_id TEXT); CREATE TABLE settings(key TEXT, value TEXT); INSERT INTO people VALUES('p1','Ada'); INSERT INTO tasks VALUES('t1','Ship it','focused','#123456',4); INSERT INTO assignments VALUES('a1','t1','p1'); INSERT INTO settings VALUES('theme','dark')");
  db.close();
  return { root, database, backups };
}

function run(f, args, extraEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, LOCAL_DATA_PATH: f.root, WORKGRID_DB_PATH: f.database, WORKGRID_BACKUP_PATH: f.backups, ...extraEnv },
  });
}

function backupId(output) {
  return JSON.parse(output.trim().split("\n").find((line) => JSON.parse(line).event === "created")).backupId;
}

test("creates, verifies, and restores a populated database with a safety backup", () => {
  const f = fixture();
  try {
    const made = run(f, ["create", "manual"]);
    assert.equal(made.status, 0, made.stderr);
    const id = backupId(made.stdout);
    assert.equal(run(f, ["verify", id]).status, 0);

    const changed = new DatabaseSync(f.database);
    changed.exec("UPDATE people SET name='Grace'");
    changed.close();
    const restored = run(f, ["restore", id, `RESTORE:${id}`]);
    assert.equal(restored.status, 0, restored.stderr);
    const checked = new DatabaseSync(f.database, { readOnly: true });
    assert.equal(checked.prepare("SELECT name FROM people").get().name, "Ada");
    assert.equal(checked.prepare("SELECT status FROM tasks").get().status, "focused");
    checked.close();
    const listed = run(f, ["list"]);
    assert.match(listed.stdout, /pre-restore/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("detects corruption before restore and keeps the live database untouched", () => {
  const f = fixture();
  try {
    const id = backupId(run(f, ["create"]).stdout);
    writeFileSync(join(f.backups, `${id}.sqlite`), "corrupt");
    const before = readFileSync(f.database);
    assert.notEqual(run(f, ["verify", id]).status, 0);
    assert.notEqual(run(f, ["restore", id, `RESTORE:${id}`]).status, 0);
    assert.deepEqual(readFileSync(f.database), before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("rejects traversal IDs, bad confirmations, stale revisions, and symlink backups", () => {
  const f = fixture();
  try {
    const id = backupId(run(f, ["create"]).stdout);
    assert.notEqual(run(f, ["verify", "../../board"]).status, 0);
    assert.notEqual(run(f, ["restore", id, "yes"]).status, 0);
    assert.notEqual(run(f, ["restore", id, `RESTORE:${id}`, "stale"]).status, 0);
    rmSync(join(f.backups, `${id}.sqlite`));
    symlinkSync(f.database, join(f.backups, `${id}.sqlite`));
    assert.notEqual(run(f, ["verify", id]).status, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("serializes maintenance and never deletes the last backup", () => {
  const f = fixture();
  try {
    const id = backupId(run(f, ["create"]).stdout);
    assert.notEqual(run(f, ["delete", id]).status, 0);
    const lock = join(f.root, ".workgrid-database.lock");
    const lockDb = new DatabaseSync(f.database);
    try {
      // A directory is the portable atomic lock used by startup and the CLI.
      mkdirSync(lock);
      assert.notEqual(run(f, ["create"]).status, 0);
    } finally { lockDb.close(); rmSync(lock, { recursive: true, force: true }); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("write failures do not modify the source database", () => {
  const f = fixture();
  try {
    const before = readFileSync(f.database);
    const notDirectory = join(f.root, "not-a-directory");
    writeFileSync(notDirectory, "occupied");
    const result = run(f, ["create"], { WORKGRID_BACKUP_PATH: notDirectory });
    assert.notEqual(result.status, 0);
    assert.deepEqual(readFileSync(f.database), before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("retention is deterministic and preserves the newest verified backup", () => {
  const f = fixture();
  try {
    const policy = { WORKGRID_BACKUP_RETAIN_DAILY: "0", WORKGRID_BACKUP_RETAIN_WEEKLY: "0" };
    assert.equal(run(f, ["create", "first"], policy).status, 0);
    assert.equal(run(f, ["create", "second"], policy).status, 0);
    const listed = run(f, ["list"], policy);
    assert.equal(listed.status, 0, listed.stderr);
    const records = JSON.parse(listed.stdout);
    assert.equal(records.length, 1);
    assert.equal(records[0].reason, "second");
    assert.equal(run(f, ["verify", records[0].id], policy).status, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
