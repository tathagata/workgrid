// Verifies the publishable tarball: exact file allowlist, zero dependencies, no install hooks.
// Runs in CI before every publish so a stray file (e.g. .env) or a new dependency can't ship.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const EXPECTED = new Set([
  "README.md",
  "package.json",
  "bin/workgrid.js",
  "skills/workgrid/SKILL.md",
  "src/cli.js",
  "src/client.js",
  "src/commands.js",
  "src/errors.js",
  "src/output.js",
  "src/skill.js",
]);

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const failures = [];

// Distributed through GitHub Releases only; `private` makes `npm publish` refuse to run.
if (pkg.private !== true) failures.push('package.json must keep "private": true (releases go to GitHub, not npm)');
for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies"]) {
  if (pkg[field] && Object.keys(pkg[field]).length) failures.push(`package.json must not declare ${field}`);
}
for (const hook of ["preinstall", "install", "postinstall", "prepare", "preuninstall", "uninstall", "postuninstall"]) {
  if (pkg.scripts?.[hook]) failures.push(`package.json must not declare a "${hook}" script`);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const [report] = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
  shell: process.platform === "win32",
}));
const actual = new Set(report.files.map((file) => file.path));
for (const path of actual) if (!EXPECTED.has(path)) failures.push(`unexpected file in tarball: ${path}`);
for (const path of EXPECTED) if (!actual.has(path)) failures.push(`missing file in tarball: ${path}`);
if (report.size > 100_000) failures.push(`tarball unexpectedly large: ${report.size} bytes`);

const bin = report.files.find((file) => file.path === "bin/workgrid.js");
if (bin && (bin.mode & 0o111) === 0 && process.platform !== "win32") failures.push("bin/workgrid.js is not executable");

if (failures.length) {
  console.error(failures.map((failure) => `✗ ${failure}`).join("\n"));
  process.exit(1);
}
console.log(`✓ ${report.filename}: ${actual.size} files, ${report.size} bytes, 0 dependencies, no install scripts`);
