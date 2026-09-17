import type { BoardService, MutationResult } from "@/lib/application/board-service";
import { parseCommand } from "@/lib/domain/contracts";

/** Transport-only adapter kept separate so parity tests do not import Worker globals. */
export function executeHttpBoardCommand(service: BoardService, input: unknown): Promise<MutationResult> {
  return service.execute(parseCommand(input));
}
