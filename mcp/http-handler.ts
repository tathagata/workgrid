import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { BoardService } from "../lib/application/board-service.js";
import { createMcpServer } from "./create-server.js";

export interface McpHttpOptions {
  apiKey?: string;
}

/** Handle one stateless MCP Streamable HTTP request using Web-standard primitives. */
export async function handleMcpHttpRequest(request: Request, service: BoardService, options: McpHttpOptions = {}): Promise<Response> {
  if (!isAuthorized(request, options.apiKey)) {
    return Response.json({ error: "Unauthorized" }, {
      status: 401,
      headers: { "www-authenticate": 'Bearer realm="workgrid-mcp"' },
    });
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { allow: "POST, GET, DELETE, OPTIONS" } });
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createMcpServer(service);
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (error) {
    console.error("Work Grid MCP request failed.", error);
    return Response.json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Internal MCP server error" },
    }, { status: 500 });
  }
}

function isAuthorized(request: Request, configuredKey?: string) {
  const apiKey = configuredKey?.trim();
  if (!apiKey) return true;
  return request.headers.get("authorization") === `Bearer ${apiKey}`;
}
