#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = resolve(process.env.LOCAL_DATA_PATH || "/data");
const BACKUP_DIR = resolve(process.env.WORKGRID_BACKUP_PATH || join(DATA_DIR, "backups"));
const LOCK_DIR = join(DATA_DIR, ".workgrid-database.lock");
const ID_PATTERN = /^\d{8}T\d{6}Z-[a-z0-9-]{1,32}-[a-f0-9]{8}$/;
const RETAIN_DAILY = positiveInt("WORKGRID_BACKUP_RETAIN_DAILY", 7);
const RETAIN_WEEKLY = positiveInt("WORKGRID_BACKUP_RETAIN_WEEKLY", 4);
const MAX_BYTES = positiveInt("WORKGRID_BACKUP_MAX_BYTES", 1024 * 1024 * 1024);
const APP_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function positiveInt(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function log(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), component: "backup", event, ...details })}\n`);
}

function fail(message) {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), component: "backup", event: "error", message })}\n`);
  process.exitCode = 1;
}

function assertSafeDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stats = lstatSync(path, { bigint: false });
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`Unsafe directory: ${path}`);
  chmodSync(path, 0o700);
}

function walkSqlite(path) {
  if (!existsSync(path)) return [];
  const results = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === "backups" || entry.name === basename(BACKUP_DIR)) continue;
    const candidate = join(path, entry.name);
    if (entry.isDirectory()) results.push(...walkSqlite(candidate));
    else if (entry.isFile() && entry.name.endsWith(".sqlite")) results.push(candidate);
  }
  return results;
}

function databasePath({ allowMissing = false } = {}) {
  const configured = process.env.WORKGRID_DB_PATH;
  if (configured) {
    const path = resolve(configured);
    if (!allowMissing && !existsSync(path)) throw new Error("Configured database does not exist");
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Database may not be a symlink");
    return path;
  }
  const candidates = walkSqlite(DATA_DIR);
  if (candidates.length === 0 && allowMissing) return null;
  if (candidates.length !== 1) throw new Error(`Expected exactly one local SQLite database, found ${candidates.length}`);
  return candidates[0];
}

function hash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inspect(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") throw new Error("SQLite integrity check failed");
    const userVersion = db.prepare("PRAGMA user_version").get().user_version;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
    const schemaSql = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    const schemaHash = createHash("sha256").update(JSON.stringify(schemaSql)).digest("hex");
    return { userVersion, tables, schemaHash };
  } finally {
    db.close();
  }
}

function paths(id) {
  if (!ID_PATTERN.test(id)) throw new Error("Invalid backup ID");
  return { database: join(BACKUP_DIR, `${id}.sqlite`), metadata: join(BACKUP_DIR, `${id}.json`) };
}

function metadataFor(id) {
  const target = paths(id);
  for (const path of [target.database, target.metadata]) {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw new Error("Backup is missing or unsafe");
  }
  const metadata = JSON.parse(readFileSync(target.metadata, "utf8"));
  if (metadata.id !== id || metadata.formatVersion !== 1) throw new Error("Backup metadata is incompatible");
  return { target, metadata };
}

function verify(id) {
  const { target, metadata } = metadataFor(id);
  if (hash(target.database) !== metadata.sha256) throw new Error("Backup checksum verification failed");
  const details = inspect(target.database);
  if (details.userVersion !== metadata.schemaVersion) throw new Error("Backup schema metadata mismatch");
  if (details.schemaHash !== metadata.schemaHash) throw new Error("Backup schema fingerprint mismatch");
  log("verified", { backupId: id, sizeBytes: metadata.sizeBytes, schemaVersion: metadata.schemaVersion });
  return metadata;
}

function withLock(action, { alreadyHeld = false } = {}) {
  if (alreadyHeld) return action();
  assertSafeDirectory(DATA_DIR);
  try {
    mkdirSync(LOCK_DIR, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("Another database maintenance operation is active");
    throw error;
  }
  try { return action(); } finally { rmSync(LOCK_DIR, { recursive: true, force: true }); }
}

function makeId(reason) {
  const cleanReason = String(reason || "manual").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "manual";
  return `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}-${cleanReason}-${randomBytes(4).toString("hex")}`;
}

function create(reason = "manual", options = {}) {
  return withLock(() => {
    assertSafeDirectory(BACKUP_DIR);
    const source = databasePath({ allowMissing: options.allowMissing });
    if (!source) { log("skipped", { reason: "database-not-created" }); return null; }
    const id = makeId(reason);
    const target = paths(id);
    const temporary = `${target.database}.tmp-${process.pid}`;
    try {
      const sourceDb = new DatabaseSync(source);
      try {
        sourceDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        sourceDb.exec(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);
      } finally { sourceDb.close(); }
      chmodSync(temporary, 0o600);
      const details = inspect(temporary);
      const stats = statSync(temporary);
      const metadata = { formatVersion: 1, id, createdAt: new Date().toISOString(), reason, appVersion: APP_VERSION, schemaVersion: details.userVersion, schemaHash: details.schemaHash, tables: details.tables, sizeBytes: stats.size, sha256: hash(temporary) };
      const metadataTemp = `${target.metadata}.tmp-${process.pid}`;
      writeFileSync(metadataTemp, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, target.database);
      renameSync(metadataTemp, target.metadata);
      verify(id);
      applyRetention(id, options.protectBackupIds || []);
      log("created", { backupId: id, reason, sizeBytes: stats.size });
      return id;
    } catch (error) {
      rmSync(temporary, { force: true });
      rmSync(`${target.metadata}.tmp-${process.pid}`, { force: true });
      throw error;
    }
  }, options);
}

function list() {
  assertSafeDirectory(BACKUP_DIR);
  return readdirSync(BACKUP_DIR).filter((name) => name.endsWith(".json")).flatMap((name) => {
    const id = name.slice(0, -5);
    if (!ID_PATTERN.test(id)) return [];
    try { return [metadataFor(id).metadata]; } catch { return []; }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function retentionKeep(backups) {
  const keep = new Set();
  const daily = new Set();
  const weekly = new Set();
  for (const backup of backups) {
    const date = new Date(backup.createdAt);
    const day = backup.createdAt.slice(0, 10);
    const weekStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() + 6) % 7))).toISOString().slice(0, 10);
    if (daily.size < RETAIN_DAILY && !daily.has(day)) { daily.add(day); keep.add(backup.id); }
    if (weekly.size < RETAIN_WEEKLY && !weekly.has(weekStart)) { weekly.add(weekStart); keep.add(backup.id); }
  }
  if (backups[0]) keep.add(backups[0].id);
  return keep;
}

function remove(id) {
  const target = paths(id);
  unlinkSync(target.database);
  unlinkSync(target.metadata);
  log("deleted", { backupId: id });
}

function applyRetention(newId, protectedIds = []) {
  const backups = list();
  const keep = retentionKeep(backups);
  for (const id of protectedIds) keep.add(id);
  let retainedBytes = backups.filter((item) => keep.has(item.id)).reduce((sum, item) => sum + item.sizeBytes, 0);
  for (const backup of [...backups].reverse()) {
    if (backup.id === newId || keep.has(backup.id)) continue;
    if (backups.length <= 1) break;
    remove(backup.id);
  }
  if (retainedBytes > MAX_BYTES) log("retention_budget_exceeded", { retainedBytes, maxBytes: MAX_BYTES, reason: "protected-generations" });
}

function deleteBackup(id) {
  return withLock(() => {
    verify(id);
    const backups = list();
    if (backups.length <= 1) throw new Error("Cannot delete the last known-good backup");
    let anotherGoodBackup = false;
    for (const backup of backups) {
      if (backup.id === id) continue;
      try { verify(backup.id); anotherGoodBackup = true; break; } catch { /* continue checking */ }
    }
    if (!anotherGoodBackup) throw new Error("Cannot delete the last known-good backup");
    remove(id);
  });
}

function restore(id, confirmation, expectedRevision) {
  return withLock(() => {
    if (confirmation !== `RESTORE:${id}`) throw new Error("Restore confirmation does not match RESTORE:<backupId>");
    const metadata = verify(id);
    if (metadata.appVersion.split(".")[0] !== APP_VERSION.split(".")[0]) throw new Error("Backup application version is incompatible");
    const current = databasePath();
    const currentSchema = inspect(current).userVersion;
    if (metadata.schemaVersion > currentSchema) throw new Error("Backup schema is newer than the running application database");
    if (expectedRevision && hash(current) !== expectedRevision) throw new Error("Current database revision changed");
    create("pre-restore", { alreadyHeld: true, protectBackupIds: [id] });
    const candidate = `${current}.restore-${process.pid}`;
    copyFileSync(paths(id).database, candidate, constants.COPYFILE_EXCL);
    chmodSync(candidate, 0o600);
    try {
      inspect(candidate);
      const displaced = `${current}.pre-restore-${process.pid}`;
      renameSync(current, displaced);
      try { renameSync(candidate, current); } catch (error) { renameSync(displaced, current); throw error; }
      rmSync(displaced, { force: true });
      for (const suffix of ["-wal", "-shm"]) rmSync(`${current}${suffix}`, { force: true });
      log("restored", { backupId: id, schemaVersion: metadata.schemaVersion });
    } finally { rmSync(candidate, { force: true }); }
  });
}

function usage() {
  return "Usage: npm run backup -- create [reason] [--lock-held|--allow-missing] | list | verify <id> | restore <id> <RESTORE:id> [expectedRevision] | delete <id> | integrity | schedule";
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "create") create(args.find((arg) => !arg.startsWith("--")) || "manual", { alreadyHeld: args.includes("--lock-held"), allowMissing: args.includes("--allow-missing") });
  else if (command === "list") process.stdout.write(`${JSON.stringify(list(), null, 2)}\n`);
  else if (command === "verify") verify(args[0]);
  else if (command === "restore") restore(args[0], args[1], args[2]);
  else if (command === "delete") deleteBackup(args[0]);
  else if (command === "integrity") log("integrity_ok", inspect(databasePath()));
  else if (command === "schedule") {
    const interval = positiveInt("WORKGRID_BACKUP_INTERVAL_SECONDS", 86400);
    log("scheduler_started", { intervalSeconds: interval });
    while (true) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, interval * 1000));
      try { create("scheduled"); } catch (error) { fail(error.message); }
    }
  } else throw new Error(usage());
}

main().catch((error) => fail(error.message));
