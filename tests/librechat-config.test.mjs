import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const renderer = join(root, "deploy/librechat/render-config.mjs");
const template = join(root, "deploy/librechat/librechat.yaml");

function render(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "librechat-config-"));
  const output = join(directory, "librechat.yaml");
  try {
    execFileSync(process.execPath, [renderer, template, output], {
      env: {
        ...process.env,
        MCP_SANDBOX_URL: "http://localhost:3081/api/mcp/sandbox",
        MCP_SERVER_NAME: "example-mcp",
        MCP_SERVER_URL: "http://host.docker.internal:4173/api/mcp",
        MCP_SERVER_ADDRESS: "host.docker.internal:4173",
        MCP_SERVER_DESCRIPTION: "Example: tools and UI",
        LIBRECHAT_WELCOME: "Example MCP is connected.",
        WORKGRID_MCP_URL: "",
        WORKGRID_MCP_ADDRESS: "",
        WORKGRID_MCP_API_KEY: "",
        ...overrides,
      },
      stdio: "pipe",
    });
    return readFileSync(output, "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("standalone LibreChat template renders a generic authenticated MCP server", () => {
  const rendered = render({ MCP_SERVER_API_KEY: 'secret-with-"-quotes' });
  assert.match(rendered, /"example-mcp":/);
  assert.match(rendered, /url: "http:\/\/host\.docker\.internal:4173\/api\/mcp"/);
  assert.match(rendered, /allowedAddresses:\n\s+- "host\.docker\.internal:4173"/);
  assert.match(rendered, /headers: \{"Authorization":"Bearer secret-with-\\"-quotes"\}/);
  assert.doesNotMatch(rendered, /__[A-Z0-9_]+__/);
});

test("standalone LibreChat template omits authorization when the MCP server has no key", () => {
  const rendered = render({ MCP_SERVER_API_KEY: "" });
  assert.match(rendered, /headers: \{\}/);
  assert.doesNotMatch(rendered, /Authorization/);
});

test("renderer keeps existing Work Grid environment files compatible", () => {
  const rendered = render({
    MCP_SERVER_NAME: "",
    MCP_SERVER_URL: "",
    MCP_SERVER_ADDRESS: "",
    MCP_SERVER_API_KEY: "",
    WORKGRID_MCP_URL: "http://work-grid:4173/api/mcp",
    WORKGRID_MCP_ADDRESS: "work-grid:4173",
    WORKGRID_MCP_API_KEY: "legacy-secret",
  });
  assert.match(rendered, /"work-grid":/);
  assert.match(rendered, /url: "http:\/\/work-grid:4173\/api\/mcp"/);
  assert.match(rendered, /Bearer legacy-secret/);
});

test("renderer rejects an unsafe MCP server name", () => {
  assert.throws(() => render({ MCP_SERVER_NAME: "unsafe.server" }), /Command failed/);
});
