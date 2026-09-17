import { env } from "cloudflare:workers";
import { BoardService } from "@/lib/application/board-service";
import { ApplicationError } from "@/lib/domain/contracts";
import { D1BoardRepository } from "@/lib/persistence/d1-board-repository";
import { executeHttpBoardCommand } from "@/lib/transports/http-board-adapter";

const MAX_BODY_BYTES = 16 * 1024;

function service() {
  if (!env.DB) throw new Error("Private storage is unavailable.");
  return new BoardService(new D1BoardRepository(env.DB));
}

export async function GET(request: Request) {
  try {
    const boardService = service();
    if (new URL(request.url).searchParams.get("appearance") === "1") return Response.json(boardService.getAppearance());
    const state = await boardService.getBoard();
    if (new URL(request.url).searchParams.get("export") === "1") {
      return new Response(JSON.stringify(state, null, 2), { headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename=\"work-distribution-${new Date().toISOString().slice(0, 10)}.json\"`,
      }});
    }
    return Response.json(state);
  } catch (error) {
    console.error("Could not load the board.", error);
    return Response.json({ error: { code: "INTERNAL", message: "Could not load the board." } }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_BODY_BYTES) return problem(new ApplicationError("PAYLOAD_TOO_LARGE", "Request body is too large."), 413);
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) return problem(new ApplicationError("PAYLOAD_TOO_LARGE", "Request body is too large."), 413);
    let input: unknown;
    try { input = JSON.parse(rawBody); } catch { throw new ApplicationError("INVALID_INPUT", "Request body must be valid JSON."); }
    return Response.json(await executeHttpBoardCommand(service(), input));
  } catch (error) {
    if (error instanceof ApplicationError) return problem(error, error.code === "CONFLICT" ? 409 : error.code === "NOT_FOUND" ? 404 : 400);
    console.error("Could not save that change.", error);
    return problem(new ApplicationError("INTERNAL", "Could not save that change."), 500);
  }
}

function problem(error: ApplicationError, status: number) {
  return Response.json({ error: error.toJSON() }, { status });
}
