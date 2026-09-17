import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BoardService, type BoardRepository } from "../lib/application/board-service";
import type { BoardCommand } from "../lib/domain/contracts";
import { createMcpServer } from "../mcp/server";
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
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ["board.get", "appearance.get", "people.list", "people.create", "people.update", "people.delete", "people.reorder", "tasks.list", "tasks.create", "tasks.update", "tasks.delete", "tasks.setWorkflowState", "assignments.assign", "assignments.unassign", "assignments.setFocus"]) assert.ok(tools.includes(name), `${name} missing`);
    const appearance = await client.callTool({ name: "appearance.get", arguments: {} });
    assert.match(JSON.stringify(appearance.structuredContent), /"paletteVersion":1/);
    assert.match(JSON.stringify(appearance.structuredContent), /"peoplePalette":\[/);
    const result = await client.callTool({ name: "people.create", arguments: { payload: { name: "Grace", role: "Staff" } } });
    assert.equal(result.isError, undefined);
    assert.equal(calls[0]?.action, "addPerson");
    const resource = await client.readResource({ uri: "workgrid://board" });
    const content = resource.contents[0];
    assert.match(content && "text" in content ? content.text : "", /"apiVersion": 1/);
  } finally { await client.close(); await server.close(); }
});

test("MCP returns sanitized structured errors", async () => {
  const repository: BoardRepository = { async readBoard() { return { people: [], tasks: [], assignments: [] }; }, async execute() {} };
  const server = createMcpServer(new BoardService(repository));
  const client = new Client({ name: "contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "people.create", arguments: { payload: { name: "", sql: "secret" } } });
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
  try { await client.callTool({ name: "people.create", arguments: { payload: { name: "Ada", role: "Lead" } } }); }
  finally { await client.close(); await server.close(); }
  assert.deepEqual(calls[0], calls[1]);
});
