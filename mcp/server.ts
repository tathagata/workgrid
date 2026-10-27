import { join, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BoardService } from "../lib/application/board-service.js";
import { D1BoardRepository } from "../lib/persistence/d1-board-repository.js";
import { CliBackupService } from "../lib/persistence/cli-backup-service.js";
import { createMcpServer } from "./create-server.js";
import { openLocalDatabase, resolveLocalDatabasePath } from "./sqlite-database.js";

export { createMcpServer };

async function main() {
  const databasePath = resolveLocalDatabasePath();
  const database = openLocalDatabase();
  const dataRoot = resolve(process.cwd(), ".wrangler/state");
  const backups = new CliBackupService({ databasePath, dataRoot, backupPath: join(dataRoot, "workgrid-backups") });
  const server = createMcpServer(new BoardService(new D1BoardRepository(database)), backups);
  const shutdown = async () => { await server.close(); database.close(); };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 64 * 1024 }));
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) main().catch((error) => { console.error(error instanceof Error ? error.message : "MCP startup failed."); process.exitCode = 1; });
