import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BoardService, type BoardRepository } from "../lib/application/board-service";
import { createMcpServer } from "../mcp/server";

function fixture(): BoardRepository {
  const state = { people: [{ id: "p1", name: "Ada", role: "", color: "#123456", colorId: null as string | null, sortOrder: 0 }], tasks: [] as unknown[], assignments: [] as unknown[], revision: 1 };
  return {
    async readBoard() { return { people: structuredClone(state.people), tasks: structuredClone(state.tasks), assignments: structuredClone(state.assignments), revision: `board:${state.revision}` } as never; },
    async execute() {},
    async createBulkTasks(input) {
      const taskIds = input.items.map(() => crypto.randomUUID());
      taskIds.forEach((id, index) => {
        const item = input.items[index];
        (state.tasks as Array<Record<string, unknown>>).push({ id, title: item.title, description: "", category: item.category, color: item.color, colorId: item.colorId, workflow: { state: item.primaryPersonId ? "focused" : "unfocused", changedAt: "2026-01-01T00:00:00.000Z" }, revision: 1, sortOrder: index, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
      });
      state.revision += 1;
      return { taskIds, revision: `board:${state.revision}` };
    },
  };
}

async function connect(repository: BoardRepository) {
  const server = createMcpServer(new BoardService(repository));
  const client = new Client({ name: "bulk-contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

test("MCP exposes tasks.parseBulk and tasks.createBulk sharing the same application-service logic as HTTP", async () => {
  const { server, client } = await connect(fixture());
  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(tools.includes("tasks.parseBulk"));
    assert.ok(tools.includes("tasks.createBulk"));

    const parsed = await client.callTool({ name: "tasks.parseBulk", arguments: { payload: { text: "Ship it @primary:p1\nAnother task" } } });
    assert.equal(parsed.isError, undefined);
    assert.match(JSON.stringify(parsed.structuredContent), /"primaryPersonId":"p1"/);

    const created = await client.callTool({ name: "tasks.createBulk", arguments: { payload: {
      syntaxVersion: "1", mode: "atomic", idempotencyKey: "mcp-contract-key-1",
      items: [{ clientId: "line-1", title: "Ship it", primaryPersonId: "p1" }],
    } } });
    assert.equal(created.isError, undefined);
    assert.match(JSON.stringify(created.structuredContent), /"revision":"board:2"/);
  } finally { await client.close(); await server.close(); }
});

test("MCP returns a sanitized structured error for an invalid bulk create request", async () => {
  const { server, client } = await connect(fixture());
  try {
    const result = await client.callTool({ name: "tasks.createBulk", arguments: { payload: { syntaxVersion: "1", mode: "atomic", idempotencyKey: "short", items: [] } } });
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /stack|\/Users\//);
  } finally { await client.close(); await server.close(); }
});
