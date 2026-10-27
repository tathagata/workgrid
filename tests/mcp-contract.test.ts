import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BoardService, type BoardRepository } from "../lib/application/board-service";
import type { BoardCommand } from "../lib/domain/contracts";
import { createMcpServer } from "../mcp/server";
import { MCP_APP_MIME_TYPE, WORKGRID_BOARD_UI_URI } from "../mcp/workgrid-app";
import { executeHttpBoardCommand } from "../lib/transports/http-board-adapter";

test("MCP exposes board resources and all current mutations over the shared service", async () => {
  const calls: BoardCommand[] = [];
  const repository: BoardRepository = {
    async readBoard() { return { people: [], tasks: [], assignments: [] }; },
    async execute(command) { calls.push(command); },
  };
  const server = createMcpServer(new BoardService(repository, () => new Date("2026-02-01T00:00:00.000Z")));
  const client = new Client({ name: "contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listedTools = (await client.listTools()).tools;
    const tools = listedTools.map((tool) => tool.name);
    for (const name of ["board_get", "appearance_get", "people_list", "people_create", "people_update", "people_delete", "people_reorder", "tasks_list", "tasks_create", "tasks_update", "tasks_delete", "tasks_set_workflow_state", "assignments_assign", "assignments_unassign", "assignments_set_focus"]) assert.ok(tools.includes(name), `${name} missing`);
    for (const name of tools) assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/, `${name} is not OpenAI-compatible`);
    const boardTool = listedTools.find((tool) => tool.name === "board_get");
    assert.equal((boardTool?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri, WORKGRID_BOARD_UI_URI);
    assert.equal(boardTool?._meta?.["ui/resourceUri"], WORKGRID_BOARD_UI_URI);
    const appearance = await client.callTool({ name: "appearance_get", arguments: {} });
    assert.match(JSON.stringify(appearance.structuredContent), /"paletteVersion":1/);
    assert.match(JSON.stringify(appearance.structuredContent), /"peoplePalette":\[/);
    const result = await client.callTool({ name: "people_create", arguments: { payload: { name: "Grace", role: "Staff" } } });
    assert.equal(result.isError, undefined);
    assert.equal(calls[0]?.action, "addPerson");
    const resource = await client.readResource({ uri: "workgrid://board" });
    const content = resource.contents[0];
    assert.match(content && "text" in content ? content.text : "", /"apiVersion": 1/);
    const appResource = await client.readResource({ uri: WORKGRID_BOARD_UI_URI });
    const appContent = appResource.contents[0];
    assert.equal(appContent?.mimeType, MCP_APP_MIME_TYPE);
    assert.match(appContent && "text" in appContent ? appContent.text : "", /ui\/notifications\/tool-result/);
    assert.match(appContent && "text" in appContent ? appContent.text : "", /<h1>Work Grid<\/h1>/);
  } finally { await client.close(); await server.close(); }
});

test("MCP returns sanitized structured errors", async () => {
  const repository: BoardRepository = { async readBoard() { return { people: [], tasks: [], assignments: [] }; }, async execute() {} };
  const server = createMcpServer(new BoardService(repository));
  const client = new Client({ name: "contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "people_create", arguments: { payload: { name: "", sql: "secret" } } });
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /stack|\/Users\//);
  } finally { await client.close(); await server.close(); }
});

test("HTTP and MCP adapters execute identical validated commands", async () => {
  const calls: BoardCommand[] = [];
  const repository: BoardRepository = { async readBoard() { return { people: [], tasks: [], assignments: [] }; }, async execute(command) { calls.push(command); } };
  const service = new BoardService(repository);
  await executeHttpBoardCommand(service, { action: "addPerson", payload: { name: "Ada", role: "Lead" } });
  const server = createMcpServer(service);
  const client = new Client({ name: "parity-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try { await client.callTool({ name: "people_create", arguments: { payload: { name: "Ada", role: "Lead" } } }); }
  finally { await client.close(); await server.close(); }
  assert.deepEqual(calls[0], calls[1]);
});
