import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CliError, EXIT } from "./errors.js";

export const SKILL_NAME = "workgrid";
export const BUNDLED_SKILL_PATH = fileURLToPath(new URL(`../skills/${SKILL_NAME}/SKILL.md`, import.meta.url));
/** Marker in SKILL.md frontmatter that identifies a copy this CLI owns and may replace. */
const OWNERSHIP_MARKER = /^\s+source:\s*work-distribution-grid-cli\s*$/m;

/**
 * Where each agent discovers skills. `.agents/skills` is the cross-agent location read by
 * OpenAI Codex and GitHub Copilot (CLI, coding agent, and VS Code agent mode).
 */
export const SKILL_TARGETS = Object.freeze({
  agents: { label: "Codex + Copilot (.agents)", user: [".agents", "skills"], project: [".agents", "skills"] },
  copilot: { label: "GitHub Copilot", user: [".copilot", "skills"], project: [".github", "skills"] },
  claude: { label: "Claude Code", user: [".claude", "skills"], project: [".claude", "skills"] },
});
export const SKILL_AGENTS = ["agents", "codex", "copilot", "claude", "all"];

export function resolveTargets(agent, scope, { home = homedir(), cwd = process.cwd() } = {}) {
  const names = agent === "all" ? Object.keys(SKILL_TARGETS) : [agent === "codex" ? "agents" : agent];
  return names.map((name) => {
    const target = SKILL_TARGETS[name];
    const base = scope === "project" ? cwd : home;
    const dir = resolve(base, ...target[scope], SKILL_NAME);
    return { agent: name, label: target.label, scope, dir, path: join(dir, "SKILL.md"), base };
  });
}

export async function readBundledSkill() {
  try {
    return await readFile(BUNDLED_SKILL_PATH, "utf8");
  } catch {
    throw new CliError("SKILL_MISSING", "The bundled SKILL.md is missing; reinstall work-distribution-grid-cli.", EXIT.FAILURE);
  }
}

async function lstatOrNull(path) {
  try { return await lstat(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

/** Refuses to follow a symlink anywhere between the base directory and the skill file. */
async function assertNoSymlinks(base, path) {
  const parts = path.slice(base.length).split(/[\\/]+/).filter(Boolean);
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    const stats = await lstatOrNull(current);
    if (!stats) return;
    if (stats.isSymbolicLink()) {
      throw new CliError("UNSAFE_PATH", `Refusing to write through symbolic link ${current}.`, EXIT.FAILURE);
    }
  }
}

export async function inspectSkill(target, bundled) {
  const stats = await lstatOrNull(target.path);
  if (!stats) return "absent";
  if (stats.isSymbolicLink() || !stats.isFile()) return "foreign";
  const current = await readFile(target.path, "utf8");
  if (current === bundled) return "current";
  return OWNERSHIP_MARKER.test(current) ? "outdated" : "foreign";
}

export async function installSkill(target, bundled, { force = false, dryRun = false } = {}) {
  await assertNoSymlinks(target.base, target.path);
  const state = await inspectSkill(target, bundled);
  if (state === "current") return { ...summary(target), status: "unchanged" };
  if (state === "foreign" && !force) {
    throw new CliError("SKILL_CONFLICT", `${target.path} exists and was not installed by this CLI. Inspect it, then rerun with --force to replace it.`, EXIT.CONFLICT);
  }
  const status = state === "absent" ? "installed" : "updated";
  if (dryRun) return { ...summary(target), status: `would-${status === "installed" ? "install" : "update"}` };
  await mkdir(target.dir, { recursive: true, mode: 0o755 });
  await assertNoSymlinks(target.base, target.path);
  // Atomic replace: write a private temp file in the same directory, then rename over.
  const temp = join(target.dir, `.SKILL.md.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temp, bundled, { mode: 0o644, flag: "wx" });
    await rename(temp, target.path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return { ...summary(target), status };
}

export async function uninstallSkill(target, bundled, { force = false, dryRun = false } = {}) {
  await assertNoSymlinks(target.base, target.path);
  const state = await inspectSkill(target, bundled);
  if (state === "absent") return { ...summary(target), status: "absent" };
  if (state === "foreign" && !force) {
    throw new CliError("SKILL_CONFLICT", `${target.path} was not installed by this CLI; refusing to remove it without --force.`, EXIT.CONFLICT);
  }
  if (dryRun) return { ...summary(target), status: "would-remove" };
  await rm(target.path, { force: true });
  await rmdir(target.dir).catch(() => {}); // only if now empty
  return { ...summary(target), status: "removed" };
}

function summary(target) {
  return { agent: target.agent, scope: target.scope, path: target.path };
}

