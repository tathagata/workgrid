import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { COMMANDS } from "../src/commands.js";
import { sanitizeText, toJson } from "../src/output.js";

const ESC = "\x1b";
const EVIL = `Fix ${ESC}]52;c;cm0gLXJmIH4=${ESC}\\ bug\u202e`;

function response(body, init = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

function run(args, { fetch = async () => { throw new Error("unexpected request"); }, env = {}, stdin, tty = false, ...deps } = {}) {
  let stdout = "";
  let stderr = "";
  const io = {
    env,
    stdin: stdin ?? (async () => ""),
    stdout: { isTTY: tty, write(value) { stdout += value; } },
    stderr: { isTTY: tty, write(value) { stderr += value; } },
  };
  return runCli(args, io, { fetch, ...deps }).then((code) => ({ code, stdout, stderr }));
}

const BOARD = {
  apiVersion: 1,
  revision: "board:12",
  people: [{ id: "p1", name: "Ada", role: "Eng", load: { score: 3, state: "overloaded" } }],
  tasks: [
    { id: "t1", title: EVIL, category: "ops", workflow: { state: "focused" }, focusAssessment: { state: "focused" } },
    { id: "t2", title: "Old", category: "", workflow: { state: "archived" }, focusAssessment: null },
  ],
  assignments: [{ taskId: "t1", personId: "p1", focus: "primary" }],
  settings: { overfocusThreshold: 2 },
};

test("output mode: JSON when piped, text on a TTY, overridable both ways", async () => {
  const fetch = async () => response(BOARD);
  assert.equal(JSON.parse((await run(["people", "list"], { fetch })).stdout).ok, true);
  const text = await run(["people", "list"], { fetch, tty: true, env: { NO_COLOR: "1" } });
  assert.match(text.stdout, /^ID\s+NAME\s+ROLE\s+LOAD\s+STATE/);
  assert.match(text.stdout, /p1\s+Ada\s+Eng\s+3\s+overloaded/);
  assert.equal(JSON.parse((await run(["people", "list", "--json"], { fetch, tty: true })).stdout).ok, true);
  assert.equal(JSON.parse((await run(["people", "list"], { fetch, tty: true, env: { WORKGRID_OUTPUT: "json" } })).stdout).ok, true);
  assert.match((await run(["people", "list", "--output", "text"], { fetch })).stdout, /overloaded/);
});

test("text output never emits terminal escape sequences from board content", async () => {
  const { stdout } = await run(["tasks", "list", "--output", "text"], { fetch: async () => response(BOARD), env: { NO_COLOR: "1" } });
  assert.doesNotMatch(stdout, /\x1b/);
  assert.doesNotMatch(stdout, /\u202e/);
  assert.match(stdout, /Fix .*bug/);
  assert.match(stdout, /OWNER/);
  assert.match(stdout, /Ada/);
});

test("JSON output escapes C1 and bidi controls but round-trips the exact value", async () => {
  const value = { title: `a\u009bb\u202ec` };
  const encoded = toJson(value, false);
  assert.doesNotMatch(encoded, /[\u009b\u202e]/);
  assert.deepEqual(JSON.parse(encoded), value);
  assert.equal(sanitizeText(`x${ESC}[31my`), "x\ufffd[31my");
});

test("colors are applied only when allowed", async () => {
  const fetch = async () => response(BOARD);
  assert.match((await run(["people", "list"], { fetch, tty: true })).stdout, /\x1b\[/);
  assert.doesNotMatch((await run(["people", "list", "--no-color"], { fetch, tty: true })).stdout, /\x1b\[/);
  assert.doesNotMatch((await run(["people", "list"], { fetch, tty: true, env: { NO_COLOR: "1" } })).stdout, /\x1b\[/);
});

test("tasks list filters by state, assignee, and category", async () => {
  const fetch = async () => response(BOARD);
  assert.deepEqual(JSON.parse((await run(["tasks", "list", "--state", "archived"], { fetch })).stdout).data.map((task) => task.id), ["t2"]);
  assert.deepEqual(JSON.parse((await run(["tasks", "list", "--assignee", "p1"], { fetch })).stdout).data.map((task) => task.id), ["t1"]);
  assert.deepEqual(JSON.parse((await run(["tasks", "list", "--category", ""], { fetch })).stdout).data.map((task) => task.id), ["t2"]);
});

test("mutations render a concise confirmation in text mode", async () => {
  const fetch = async () => response({ board: { revision: "board:13" }, changed: { kind: "task", id: "t1" } });
  const { stdout } = await run(["assignments", "set", "t1", "p1", "--focus", "primary", "--output", "text"], { fetch, env: { NO_COLOR: "1" } });
  assert.equal(stdout, "✓ Updated task t1 (revision board:13)\n");
});

test("help is available at every level without contacting the server", async () => {
  const root = await run(["--help"]);
  assert.equal(root.code, 0);
  for (const command of COMMANDS) assert.ok(root.stdout.includes(command.path.join(" ")), command.path.join(" "));
  const group = await run(["tasks", "--help"]);
  assert.match(group.stdout, /tasks archive TASK_ID/);
  assert.doesNotMatch(group.stdout, /people create/);
  const leaf = await run(["tasks", "archive", "-h"]);
  assert.match(leaf.stdout, /Usage: workgrid tasks archive TASK_ID \[--outcome completed\|cancelled\|superseded\]/);
  assert.equal((await run(["help", "bulk", "create"])).stdout.includes("--idempotency-key KEY"), true);
  assert.match((await run(["people", "delete", "--help"])).stdout, /permanent/);
});

test("unknown commands suggest the closest match", async () => {
  const typo = await run(["taks", "list"]);
  assert.equal(typo.code, 2);
  assert.equal(JSON.parse(typo.stderr).error.hint, "Did you mean `workgrid tasks`? Run workgrid --help.");
  const sub = await run(["tasks", "lst"]);
  assert.match(JSON.parse(sub.stderr).error.hint, /workgrid tasks list/);
});

test("options are validated locally before any request", async (t) => {
  const cases = [
    [["people", "reorder", "p1", "--position", "first", "--expected-revision", "7"], /board:N/],
    [["tasks", "archive", "t1", "--expected-revision", "board:7"], /positive integer/],
    [["tasks", "list", "--state", "done"], /must be one of/],
    [["tasks", "create", "--title", "x", "--bogus", "1"], /Unknown option --bogus/],
    [["tasks", "create"], /--title is required/],
    [["tasks", "update", "t1"], /at least one field/],
    [["tasks", "update", "../etc"], /Invalid argument/],
    [["people", "reorder", "p1", "--before", "p2", "--position", "last"], /exactly one/],
    [["bulk", "create", "--idempotency-key", "short"], /8–128/],
    [["settings", "update", "--overfocus-threshold", "1e9"], /must be a number/],
    [["board", "get", "--timeout", "0"], /--timeout/],
    [["board", "get", "--url", "file:///etc/passwd"], /HTTP or HTTPS/],
    [["board", "get", "--url", "https://user:pw@example.com"], /credentials/],
  ];
  for (const [args, pattern] of cases) {
    await t.test(args.join(" "), async () => {
      const result = await run(args);
      assert.equal(result.code, 2, result.stderr);
      assert.match(JSON.parse(result.stderr).error.message, pattern);
    });
  }
});

test("values that start with -- can be passed with = and -- ends option parsing", async () => {
  let body;
  const fetch = async (_url, init) => { body = JSON.parse(init.body); return response({ board: {}, changed: null }); };
  assert.equal((await run(["tasks", "create", "--title=--weird", "--category", "-x"], { fetch })).code, 0);
  assert.equal(body.payload.title, "--weird");
  assert.equal(body.payload.category, "-x");
});

test("authentication failures map to exit 5 and never echo the token", async () => {
  const result = await run(["board", "get"], { fetch: async () => response("nope", { status: 401, headers: { "content-type": "text/plain" } }), env: { WORKGRID_TOKEN: "s3cret-token" } });
  assert.equal(result.code, 5);
  assert.equal(JSON.parse(result.stderr).error.code, "AUTH_FAILED");
  assert.doesNotMatch(result.stderr, /s3cret/);
});

test("tokens with control characters are rejected before any request", async () => {
  const result = await run(["board", "get"], { env: { WORKGRID_TOKEN: "abc\r\nX-Evil: 1" } });
  assert.equal(result.code, 5);
  assert.equal(JSON.parse(result.stderr).error.code, "INVALID_TOKEN");
});

test("loopback HTTP is allowed (including 127.0.0.0/8), remote HTTP needs --allow-http", async () => {
  const fetch = async () => response(BOARD);
  assert.equal((await run(["board", "get", "--url", "http://127.0.0.2:4173"], { fetch })).code, 0);
  assert.equal((await run(["board", "get", "--url", "http://10.0.0.5"], { fetch })).code, 2);
  assert.equal((await run(["board", "get", "--url", "http://10.0.0.5", "--allow-http"], { fetch })).code, 0);
});

test("bulk preview reads --file and renders a readable summary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workgrid-cli-"));
  try {
    const file = join(dir, "tasks.txt");
    await writeFile(file, "Ship it #ops\n");
    let sent;
    const fetch = async (_url, init) => {
      sent = JSON.parse(init.body);
      return response({ syntaxVersion: "1", summary: { total: 1, valid: 1, withWarnings: 0, withErrors: 0 }, items: [{ clientId: "line-1", sourceLine: 1, title: "Ship it", warnings: [], errors: [] }] });
    };
    const result = await run(["bulk", "preview", "--file", file, "--output", "text"], { fetch, env: { NO_COLOR: "1" } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(sent.payload.text, "Ship it #ops\n");
    assert.match(result.stdout, /1\s+ok\s+Ship it/);
    assert.match(result.stdout, /1 valid/);
    const missing = await run(["bulk", "preview", "--file", join(dir, "nope.txt")]);
    assert.equal(missing.code, 2);
    const directory = await run(["bulk", "preview", "--file", dir]);
    assert.match(JSON.parse(directory.stderr).error.message, /regular file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("completion scripts cover every command", async () => {
  for (const shell of ["bash", "zsh", "fish"]) {
    const { code, stdout } = await run(["completion", shell]);
    assert.equal(code, 0);
    for (const command of COMMANDS.filter((item) => item.path.length === 2)) assert.ok(stdout.includes(command.path[1]), `${shell}: ${command.path.join(" ")}`);
  }
  assert.match((await run(["completion", "bash"])).stdout, /complete -o default -F _workgrid workgrid/);
  assert.equal((await run(["completion", "powershell"])).code, 2);
});

test("doctor reports node, server, and skill status without leaking the token", async () => {
  const home = await mkdtemp(join(tmpdir(), "workgrid-home-"));
  try {
    const ok = await run(["doctor"], { fetch: async () => response(BOARD), env: { WORKGRID_TOKEN: "s3cret-token" }, home, cwd: home });
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    const checks = JSON.parse(ok.stdout).data.checks;
    assert.equal(checks.find((check) => check.name === "server").status, "pass");
    assert.equal(checks.find((check) => check.name === "skill (agents, user)").status, "warn");
    assert.doesNotMatch(ok.stdout, /s3cret/);

    const down = await run(["doctor"], { fetch: async () => { throw new TypeError("fetch failed"); }, home, cwd: home });
    assert.equal(down.code, 1);
    assert.equal(JSON.parse(down.stdout).data.checks.find((check) => check.name === "server").status, "fail");

    const oldNode = await run(["doctor"], { fetch: async () => response(BOARD), home, cwd: home, nodeVersion: "20.11.0" });
    assert.equal(JSON.parse(oldNode.stdout).data.checks.find((check) => check.name === "node").status, "fail");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("skill install/upgrade/uninstall is idempotent, atomic, and refuses to clobber", async () => {
  const home = await mkdtemp(join(tmpdir(), "workgrid-home-"));
  const deps = { home, cwd: join(home, "repo") };
  const bundled = await readFile(new URL("../skills/workgrid/SKILL.md", import.meta.url), "utf8");
  const agentsPath = join(home, ".agents", "skills", "workgrid", "SKILL.md");
  try {
    const first = await run(["skill", "install"], deps);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout).data.targets.map((target) => target.status), ["installed"]);
    assert.equal(await readFile(agentsPath, "utf8"), bundled);
    if (process.platform !== "win32") assert.equal((await lstat(agentsPath)).mode & 0o777, 0o644);

    assert.deepEqual(JSON.parse((await run(["skill", "install", "--agent", "codex"], deps)).stdout).data.targets.map((target) => target.status), ["unchanged"]);

    // An older copy we installed is upgraded in place.
    await writeFile(agentsPath, bundled.replace("# Workgrid", "# Workgrid (old)"));
    assert.deepEqual(JSON.parse((await run(["skill", "install"], deps)).stdout).data.targets.map((target) => target.status), ["updated"]);

    // A file we didn't write is never overwritten without --force.
    const claudePath = join(home, ".claude", "skills", "workgrid", "SKILL.md");
    await mkdir(join(home, ".claude", "skills", "workgrid"), { recursive: true });
    await writeFile(claudePath, "---\nname: workgrid\n---\nmine\n");
    const clash = await run(["skill", "install", "--agent", "all"], deps);
    assert.equal(clash.code, 4);
    assert.equal(JSON.parse(clash.stderr).error.code, "SKILL_CONFLICT");
    assert.equal(await readFile(claudePath, "utf8"), "---\nname: workgrid\n---\nmine\n");
    assert.equal((await run(["skill", "install", "--agent", "claude", "--force"], deps)).code, 0);
    assert.equal(await readFile(claudePath, "utf8"), bundled);

    // Project scope writes beneath cwd; --dry-run writes nothing.
    await mkdir(deps.cwd);
    const dry = await run(["skill", "install", "--scope", "project", "--agent", "copilot", "--dry-run"], deps);
    assert.deepEqual(JSON.parse(dry.stdout).data.targets.map((target) => [target.status, target.path]), [["would-install", join(deps.cwd, ".github", "skills", "workgrid", "SKILL.md")]]);
    await assert.rejects(lstat(join(deps.cwd, ".github")));

    const status = JSON.parse((await run(["skill", "status"], deps)).stdout).data.targets;
    assert.deepEqual(Object.fromEntries(status.map((target) => [target.agent, target.state])), { agents: "current", copilot: "absent", claude: "current" });

    assert.deepEqual(JSON.parse((await run(["skill", "uninstall"], deps)).stdout).data.targets.map((target) => target.status), ["removed"]);
    await assert.rejects(lstat(join(home, ".agents", "skills", "workgrid")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("skill install refuses to write through a symlink", { skip: process.platform === "win32" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "workgrid-home-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "workgrid-elsewhere-"));
  try {
    await mkdir(join(home, ".agents", "skills"), { recursive: true });
    await symlink(elsewhere, join(home, ".agents", "skills", "workgrid"));
    const result = await run(["skill", "install"], { home, cwd: home });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, "UNSAFE_PATH");
    await assert.rejects(lstat(join(elsewhere, "SKILL.md")));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test("skill show prints the bundled skill, which matches the repository copy", async () => {
  const bundled = await readFile(new URL("../skills/workgrid/SKILL.md", import.meta.url), "utf8");
  const repoCopy = await readFile(new URL("../../.agents/skills/workgrid/SKILL.md", import.meta.url), "utf8").catch(() => null);
  if (repoCopy !== null) assert.equal(repoCopy, bundled, "Run `npm run skill:sync` from the repository root.");
  assert.equal((await run(["skill", "show"])).stdout, bundled);
});

test("SKILL.md frontmatter follows the Agent Skills spec", async () => {
  const text = await readFile(new URL("../skills/workgrid/SKILL.md", import.meta.url), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, "frontmatter");
  const name = /^name: (.+)$/m.exec(match[1])?.[1];
  const description = /^description: (.+)$/m.exec(match[1])?.[1];
  const compatibility = /^compatibility: (.+)$/m.exec(match[1])?.[1];
  assert.equal(name, "workgrid");
  assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(description.length > 0 && description.length <= 1024);
  assert.ok(compatibility.length <= 500);
  assert.match(match[1], /^metadata:\n {2}source: work-distribution-grid-cli$/m);
  assert.ok(text.split("\n").length < 500, "keep SKILL.md under 500 lines");
  // Every command the skill mentions must exist.
  for (const [, resource, command] of text.matchAll(/workgrid ([a-z]+) ([a-z]+)/g)) {
    if (["board", "people", "tasks", "assignments", "settings", "bulk", "skill", "appearance"].includes(resource)) {
      assert.ok(COMMANDS.some((item) => item.path[0] === resource && item.path[1] === command), `${resource} ${command}`);
    }
  }
});

// ── Regression tests for the PR #19 review ─────────────────────────────────────

test("updates are pinned to the revision they read, so concurrent edits conflict instead of being overwritten", async (t) => {
  for (const [args, action] of [[["tasks", "update", "t1", "--title", "New"], "updateTask"], [["people", "update", "p1", "--role", "Lead"], "updatePerson"]]) {
    await t.test(action, async () => {
      const posts = [];
      const fetch = async (_url, init) => {
        if (init.method === "GET") return response(BOARD);
        posts.push(JSON.parse(init.body));
        return response({ error: { code: "CONFLICT", message: "The board changed since it was read.", field: "expectedRevision", details: { currentRevision: "board:13" } } }, { status: 409 });
      };
      const result = await run(args, { fetch });
      assert.equal(posts[0].action, action);
      assert.equal(posts[0].payload.expectedRevision, "board:12");
      assert.equal(result.code, 4);
      assert.equal(JSON.parse(result.stderr).error.code, "CONFLICT");
    });
  }
  await t.test("an explicit --expected-revision wins", async () => {
    let post;
    const fetch = async (_url, init) => {
      if (init.method === "GET") return response(BOARD);
      post = JSON.parse(init.body);
      return response({ board: { revision: "board:9" }, changed: { kind: "task", id: "t1" } });
    };
    assert.equal((await run(["tasks", "update", "t1", "--title", "x", "--expected-revision", "board:8"], { fetch })).code, 0);
    assert.equal(post.payload.expectedRevision, "board:8");
  });
});

test("bash and zsh completion offer shell names after `workgrid completion`", async () => {
  for (const shell of ["bash", "zsh"]) {
    const { stdout } = await run(["completion", shell]);
    assert.match(stdout, /completion\) words="bash zsh fish" ;;/);
    assert.doesNotMatch(stdout, /completion\) words="" ;;/);
    assert.doesNotMatch(stdout, /doctor\) words="" ;;/);
  }
  const zsh = (await run(["completion", "zsh"])).stdout;
  assert.doesNotMatch(zsh, /fpath/, "the bashcompinit bridge cannot be autoloaded from $fpath");
  assert.match(zsh, /eval "\$\(workgrid completion zsh\)"/);
});

test("idempotency keys use the API's character set and fail before any request", async () => {
  for (const key of ["import:2026-11-12", "has space key", "dots.are.not.ok"]) {
    const result = await run(["bulk", "create", "--idempotency-key", key]);
    assert.equal(result.code, 2, key);
    assert.match(JSON.parse(result.stderr).error.message, /letters, digits, _ or -/);
  }
});

test("skill --force never replaces a directory at the SKILL.md path, and writes nothing", async () => {
  const home = await mkdtemp(join(tmpdir(), "workgrid-home-"));
  try {
    await mkdir(join(home, ".copilot", "skills", "workgrid", "SKILL.md"), { recursive: true });
    const result = await run(["skill", "install", "--agent", "all", "--force"], { home, cwd: home });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, "UNSAFE_PATH");
    await assert.rejects(lstat(join(home, ".agents", "skills", "workgrid", "SKILL.md")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a filesystem failure part-way through restores targets already written", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "workgrid-home-"));
  const { chmod } = await import("node:fs/promises");
  const locked = join(home, ".copilot", "skills", "workgrid");
  try {
    // An outdated copy we own at the agents target, to prove it is restored rather than deleted.
    const bundled = await readFile(new URL("../skills/workgrid/SKILL.md", import.meta.url), "utf8");
    const agentsPath = join(home, ".agents", "skills", "workgrid", "SKILL.md");
    const previous = bundled.replace("# Workgrid", "# Workgrid (old)");
    await mkdir(join(home, ".agents", "skills", "workgrid"), { recursive: true });
    await writeFile(agentsPath, previous);
    await mkdir(locked, { recursive: true });
    await chmod(locked, 0o555); // preflight passes (nothing to read), the write fails
    const result = await run(["skill", "install", "--agent", "all"], { home, cwd: home });
    assert.equal(result.code, 1, result.stderr);
    const error = JSON.parse(result.stderr).error;
    assert.equal(error.code, "SKILL_WRITE_FAILED");
    assert.equal(error.details.rolledBack, true);
    assert.equal(await readFile(agentsPath, "utf8"), previous);
  } finally {
    await chmod(locked, 0o755).catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
});
