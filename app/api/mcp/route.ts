import { env } from "cloudflare:workers";
import { BoardService } from "@/lib/application/board-service";
import { D1BoardRepository } from "@/lib/persistence/d1-board-repository";
import { handleMcpHttpRequest } from "@/mcp/http-handler";

function service() {
  if (!env.DB) throw new Error("Private storage is unavailable.");
  return new BoardService(new D1BoardRepository(env.DB));
}

function handle(request: Request) {
  return handleMcpHttpRequest(request, service(), { apiKey: process.env.WORKGRID_MCP_API_KEY });
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export const OPTIONS = handle;
