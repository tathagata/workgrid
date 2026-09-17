import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BoardService, type BoardRepository } from "../lib/application/board-service";
import type { BackupRecord, BackupService } from "../lib/backup-service";
import { createMcpServer } from "../mcp/server";

const repository: BoardRepository = { async readBoard() { return { people: [], tasks: [], assignments: [] }; }, async execute() {} };

function fakeBackups(): BackupService & { calls: string[] } {
  const record: BackupRecord = { id: "20260101T000000Z-manual-deadbeef", createdAt: "2026-01-01T00:00:00.000Z", reason: "manual", appVersion: "0.1.0", schemaVersion: 3, sizeBytes: 100, sha256: "abc" };
  return {
    calls: [] as string[],
    async create() { this.calls.push("create"); return { backupId: record.id }; },
    async list() { this.calls.push("list"); return [record]; },
    async verify() { this.calls.push("verify"); return record; },
    async restore() { this.calls.push("restore"); },
    async delete() { this.calls.push("delete"); },
  };
}

async function connect(backups?: BackupService) {
  const server = createMcpServer(new BoardService(repository), backups);
  const client = new Client({ name: "backup-contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

test("MCP exposes backup tools that call through to the shared backup service", async () => {
  const backups = fakeBackups();
  const { server, client } = await connect(backups);
  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ["backup.create", "backup.list", "backup.verify", "backup.restore", "backup.delete"]) assert.ok(tools.includes(name), `${name} missing`);

    const created = await client.callTool({ name: "backup.create", arguments: { reason: "manual" } });
    assert.equal(created.isError, undefined);
    assert.match(JSON.stringify(created.structuredContent), /deadbeef/);

    const listed = await client.callTool({ name: "backup.list", arguments: {} });
    assert.match(JSON.stringify(listed.structuredContent), /"schemaVersion":3/);

    await client.callTool({ name: "backup.verify", arguments: { backupId: "20260101T000000Z-manual-deadbeef" } });
    await client.callTool({ name: "backup.restore", arguments: { backupId: "20260101T000000Z-manual-deadbeef", confirmation: "RESTORE:20260101T000000Z-manual-deadbeef" } });
    await client.callTool({ name: "backup.delete", arguments: { backupId: "20260101T000000Z-manual-deadbeef" } });
    assert.deepEqual(backups.calls, ["create", "list", "verify", "restore", "delete"]);
  } finally { await client.close(); await server.close(); }
});

test("MCP rejects a malformed backup ID before it reaches the service", async () => {
  const backups = fakeBackups();
  const { server, client } = await connect(backups);
  try {
    const result = await client.callTool({ name: "backup.verify", arguments: { backupId: "../../etc/passwd" } });
    assert.equal(result.isError, true);
    assert.deepEqual(backups.calls, []);
  } finally { await client.close(); await server.close(); }
});

test("backup tools are absent when no backup service is configured", async () => {
  const { server, client } = await connect();
  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ["backup.create", "backup.list", "backup.verify", "backup.restore", "backup.delete"]) assert.ok(!tools.includes(name), `${name} unexpectedly present`);
  } finally { await client.close(); await server.close(); }
});
