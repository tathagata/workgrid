import assert from "node:assert/strict";
import test from "node:test";

import { CLI_VERSION, runCli } from "../src/cli.js";

function response(body, init = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

function harness(fetchImpl, env = {}) {
  let stdout = "";
  let stderr = "";
  const io = {
    env,
    stdin: async () => "",
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
  };
  return {
    io,
    output() { return { stdout, stderr }; },
    run(args, overrides = {}) {
      return runCli(args, { ...io, ...overrides }, { fetch: fetchImpl });
    },
  };
}

test("board get reads the local API and emits one stable JSON envelope", async () => {
  const calls = [];
  const fixture = { apiVersion: 1, people: [], tasks: [], assignments: [], revision: "board:1" };
  const h = harness(async (url, init) => {
    calls.push({ url: String(url), init });
    return response(fixture);
  });

  assert.equal(await h.run(["board", "get"]), 0);
  assert.deepEqual(JSON.parse(h.output().stdout), { ok: true, data: fixture });
  assert.equal(h.output().stderr, "");
  assert.equal(calls[0].url, "http://127.0.0.1:4173/api/board");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
});

test("global options work before or after the command and pretty-print on request", async () => {
  const h = harness(async (url) => {
    assert.equal(String(url), "https://workgrid.example/api/board");
    return response({ revision: "board:4" });
  });

  assert.equal(await h.run(["board", "get", "--url", "https://workgrid.example", "--pretty"]), 0);
  assert.match(h.output().stdout, /\n  "ok": true,/);
});

test("task creation sends only the validated application command", async () => {
  let request;
  const h = harness(async (_url, init) => {
    request = JSON.parse(init.body);
    return response({ board: { revision: "board:2" }, changed: { kind: "task", id: "t1" } });
  });

  assert.equal(await h.run([
    "tasks", "create", "--title", "Ship CLI", "--description", "Agent ready", "--category", "Platform", "--color-id", "indigo",
  ]), 0);
  assert.deepEqual(request, {
    action: "addTask",
    payload: { title: "Ship CLI", description: "Agent ready", category: "Platform", colorId: "indigo" },
  });
});

test("task update preserves unspecified fields, leaves color to the server, and never sends derived DTO properties", async () => {
  const requests = [];
  const board = {
    tasks: [{
      id: "t1", title: "Old", description: "Keep", category: "General", color: "#123456", colorId: null,
      workflow: { state: "focused", changedAt: "2026-01-01T00:00:00.000Z" }, revision: 7, sortOrder: 3,
      focusAssessment: { state: "balanced" }, createdAt: "x", updatedAt: "y",
    }],
  };
  const h = harness(async (_url, init) => {
    if (init.method === "GET") return response(board);
    requests.push(JSON.parse(init.body));
    return response({ board: { revision: "board:2" }, changed: { kind: "task", id: "t1" } });
  });

  assert.equal(await h.run(["tasks", "update", "t1", "--title", "New"]), 0);
  assert.deepEqual(requests[0], {
    action: "updateTask",
    payload: { id: "t1", title: "New", description: "Keep", category: "General" },
  });
});

test("destructive commands require --yes before making any request", async () => {
  let calls = 0;
  const h = harness(async () => { calls += 1; return response({}); });

  assert.equal(await h.run(["tasks", "delete", "t1"]), 2);
  assert.equal(calls, 0);
  const failure = JSON.parse(h.output().stderr);
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, "CONFIRMATION_REQUIRED");
  assert.match(failure.error.message, /--yes/);
});

test("remote plaintext HTTP is rejected unless explicitly allowed", async () => {
  let calls = 0;
  const h = harness(async () => { calls += 1; return response({}); }, { WORKGRID_URL: "http://workgrid.example" });

  assert.equal(await h.run(["board", "get"]), 2);
  assert.equal(calls, 0);
  assert.match(h.output().stderr, /INSECURE_URL/);
});

test("credentials are accepted only through the environment and are not echoed in errors", async () => {
  const secret = "very-secret-token";
  const h = harness(async (_url, init) => {
    assert.equal(init.headers.authorization, `Bearer ${secret}`);
    throw new Error(`network failed with ${secret}`);
  }, { WORKGRID_TOKEN: secret });

  assert.equal(await h.run(["board", "get"]), 1);
  assert.doesNotMatch(h.output().stderr, new RegExp(secret));
  assert.match(h.output().stderr, /REQUEST_FAILED/);
});

test("API errors keep stable safe fields and map conflicts to a distinct exit code", async () => {
  const h = harness(async () => response({
    error: { code: "CONFLICT", message: "The board revision is stale.", field: "expectedRevision", details: { currentRevision: "board:9" } },
  }, { status: 409 }));

  assert.equal(await h.run(["assignments", "set", "t1", "p1", "--focus", "primary"]), 4);
  assert.deepEqual(JSON.parse(h.output().stderr), {
    ok: false,
    error: { code: "CONFLICT", message: "The board revision is stale.", field: "expectedRevision", details: { currentRevision: "board:9" } },
  });
});

test("non-JSON and oversized responses fail closed", async (t) => {
  await t.test("non-JSON", async () => {
    const h = harness(async () => response("not json", { headers: { "content-type": "text/plain" } }));
    assert.equal(await h.run(["board", "get"]), 1);
    assert.match(h.output().stderr, /INVALID_RESPONSE/);
  });
  await t.test("oversized", async () => {
    const h = harness(async () => response(`{"value":"${"x".repeat(4_300_000)}"}`));
    assert.equal(await h.run(["board", "get"]), 1);
    assert.match(h.output().stderr, /RESPONSE_TOO_LARGE/);
  });
});

test("bulk create previews stdin, refuses invalid lines, and reuses the requested idempotency key", async (t) => {
  await t.test("valid", async () => {
    const requests = [];
    const h = harness(async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      if (body.action === "tasks.parseBulk") return response({
        syntaxVersion: "1",
        summary: { total: 1, valid: 1, withWarnings: 0, withErrors: 0 },
        items: [{ clientId: "line-1", sourceLine: 1, raw: "Ship it", title: "Ship it", workflowIntent: "unfocused", warnings: [], errors: [] }],
      });
      return response({ created: [{ id: "t1" }], assignments: [], revision: "board:2" });
    });
    assert.equal(await h.run(["bulk", "create", "--idempotency-key", "agent-run-123"], { stdin: async () => "Ship it\n" }), 0);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], {
      action: "tasks.createBulk",
      payload: {
        syntaxVersion: "1", mode: "atomic", idempotencyKey: "agent-run-123",
        items: [{ clientId: "line-1", title: "Ship it" }],
      },
    });
  });

  await t.test("invalid", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      return response({
        syntaxVersion: "1",
        summary: { total: 1, valid: 0, withWarnings: 0, withErrors: 1 },
        items: [{ clientId: "line-1", title: "", errors: [{ code: "EMPTY_TITLE", message: "Missing" }], warnings: [] }],
      });
    });
    assert.equal(await h.run(["bulk", "create", "--idempotency-key", "agent-run-123"], { stdin: async () => "#tag\n" }), 2);
    assert.equal(calls, 1);
    assert.match(h.output().stderr, /BULK_VALIDATION_FAILED/);
  });
});

test("version and help do not contact the server", async () => {
  const h = harness(async () => { throw new Error("unexpected request"); });
  assert.equal(await h.run(["--version"]), 0);
  assert.equal(h.output().stdout.trim(), CLI_VERSION);

  const help = harness(async () => { throw new Error("unexpected request"); });
  assert.equal(await help.run(["--help"]), 0);
  assert.match(help.output().stdout, /tasks create/);
  assert.match(help.output().stdout, /WORKGRID_TOKEN/);
});
