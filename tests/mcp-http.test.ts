import assert from "node:assert/strict";
import test from "node:test";
import { BoardService, type BoardRepository } from "../lib/application/board-service";
import { handleMcpHttpRequest } from "../mcp/http-handler";

const repository: BoardRepository = {
  async readBoard() { return { people: [], tasks: [], assignments: [] }; },
  async execute() {},
};

function mcpRequest(body: unknown, token?: string) {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-11-25",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request("http://work-grid.test/api/mcp", { method: "POST", headers, body: JSON.stringify(body) });
}

test("Streamable HTTP MCP initializes and advertises the board App", async () => {
  const service = new BoardService(repository, () => new Date("2026-02-01T00:00:00.000Z"));
  const initialize = await handleMcpHttpRequest(mcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
      clientInfo: { name: "http-contract-test", version: "1" },
    },
  }), service);
  assert.equal(initialize.status, 200);
  const initializeBody = await initialize.json() as { result?: { serverInfo?: { name?: string } } };
  assert.equal(initializeBody.result?.serverInfo?.name, "workgrid");

  const tools = await handleMcpHttpRequest(mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), service);
  assert.equal(tools.status, 200);
  const toolsBody = await tools.json() as { result?: { tools?: Array<{ name: string; _meta?: Record<string, unknown> }> } };
  const boardTool = toolsBody.result?.tools?.find((tool) => tool.name === "board_get");
  assert.ok(boardTool);
  assert.equal((boardTool._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri, "ui://workgrid/board");
});

test("Streamable HTTP MCP enforces its optional bearer token", async () => {
  const service = new BoardService(repository);
  const denied = await handleMcpHttpRequest(mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), service, { apiKey: "test-secret" });
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("www-authenticate") ?? "", /^Bearer/);

  const allowed = await handleMcpHttpRequest(mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, "test-secret"), service, { apiKey: "test-secret" });
  assert.equal(allowed.status, 200);
});
