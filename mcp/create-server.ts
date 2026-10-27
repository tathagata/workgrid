import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BoardService } from "../lib/application/board-service.js";
import { BACKUP_ID_PATTERN, type BackupService } from "../lib/backup-service.js";
import { ApplicationError, commandSchema, parseCommand } from "../lib/domain/contracts.js";
import { MCP_APP_MIME_TYPE, WORKGRID_BOARD_APP_HTML, WORKGRID_BOARD_UI_URI } from "./workgrid-app.js";

const backupIdSchema = z.string().regex(BACKUP_ID_PATTERN, "Invalid backup ID.");

export function createMcpServer(service: BoardService, backups?: BackupService) {
  const server = new McpServer({ name: "workgrid", version: "1.1.0" }, {
    instructions: "Use board_get to inspect the current Work Grid. Its result includes an interactive board view in MCP Apps-capable hosts.",
  });
  server.registerResource("board", "workgrid://board", { title: "Workgrid board", mimeType: "application/json" }, async (uri) => jsonResource(uri.href, await service.getBoard()));
  server.registerResource("appearance", "workgrid://appearance", { title: "Workgrid appearance capabilities", mimeType: "application/json" }, async (uri) => jsonResource(uri.href, service.getAppearance()));
  server.registerResource("settings", "workgrid://settings", { title: "Workgrid board settings", mimeType: "application/json" }, async (uri) => jsonResource(uri.href, (await service.getBoard()).settings));
  server.registerResource("person", new ResourceTemplate("workgrid://people/{id}", { list: undefined }), { title: "Workgrid person", mimeType: "application/json" }, async (uri, variables) => {
    const item = (await service.getBoard()).people.find((person) => person.id === variables.id);
    if (!item) throw new ApplicationError("NOT_FOUND", "Person not found.", "id");
    return jsonResource(uri.href, item);
  });
  server.registerResource("task", new ResourceTemplate("workgrid://tasks/{id}", { list: undefined }), { title: "Workgrid task", mimeType: "application/json" }, async (uri, variables) => {
    const item = (await service.getBoard()).tasks.find((task) => task.id === variables.id);
    if (!item) throw new ApplicationError("NOT_FOUND", "Task not found.", "id");
    return jsonResource(uri.href, item);
  });
  server.registerResource("workgrid-board-app", WORKGRID_BOARD_UI_URI, {
    title: "Work Grid board view",
    description: "A read-only visual summary of people, tasks, workflow states, and load.",
    mimeType: MCP_APP_MIME_TYPE,
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
  }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: MCP_APP_MIME_TYPE,
      text: WORKGRID_BOARD_APP_HTML,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
    }],
  }));

  server.registerTool("board_get", {
    description: "Read the complete Workgrid board and display its interactive board view when the client supports MCP Apps.",
    inputSchema: z.object({}).strict(),
    _meta: {
      ui: { resourceUri: WORKGRID_BOARD_UI_URI },
      "ui/resourceUri": WORKGRID_BOARD_UI_URI,
    },
  }, async () => toolResult(await service.getBoard()));
  server.registerTool("appearance_get", { description: "Read versioned palettes for web, MCP, and TUI clients.", inputSchema: z.object({}).strict() }, async () => toolResult(service.getAppearance()));
  server.registerTool("settings_get", { description: "Read versioned focus-assessment settings and weights.", inputSchema: z.object({}).strict() }, async () => toolResult((await service.getBoard()).settings));
  server.registerTool("people_list", { description: "List people in grid order.", inputSchema: z.object({}).strict() }, async () => toolResult((await service.getBoard()).people));
  server.registerTool("people_loads", { description: "Read versioned person load metrics; filtering and sorting never change canonical grid order.", inputSchema: z.object({
    state: z.enum(["low", "balanced", "overloaded"]).optional(), sort: z.enum(["canonical", "highest", "lowest"]).optional(),
  }).strict() }, async (options) => toolResult(await service.getPeopleLoads(options)));
  server.registerTool("tasks_list", { description: "List tasks in workflow order.", inputSchema: z.object({}).strict() }, async () => toolResult((await service.getBoard()).tasks));
  server.registerTool("tasks_parse_bulk", { description: "Parse bulk-capture text into preview items (title, category, workflow intent, primary owner, color, warnings, errors) without creating anything.", inputSchema: z.object({ payload: z.record(z.unknown()) }).strict() }, async ({ payload }) => {
    try { return toolResult(await service.parseBulkTasks(payload)); } catch (error) { return toolError(error); }
  });
  server.registerTool("tasks_create_bulk", { description: "Atomically create every approved bulk-capture item and its primary assignment. Idempotent: retrying the same idempotencyKey returns the original result.", inputSchema: z.object({ payload: z.record(z.unknown()) }).strict() }, async ({ payload }) => {
    try { return toolResult(await service.createBulkTasks(payload)); } catch (error) { return toolError(error); }
  });
  for (const action of commandSchema.options.map((option) => option.shape.action.value)) {
    server.registerTool(toolName(action), { description: `Execute the ${action} Workgrid command.`, inputSchema: z.object({ payload: z.record(z.unknown()) }).strict() }, async ({ payload }) => {
      try { return toolResult(await service.execute(parseCommand({ action, payload }))); }
      catch (error) { return toolError(error); }
    });
  }
  server.registerTool("assignments_set_focus", { description: "Change an assignment's focus level.", inputSchema: z.object({ taskId: z.string(), personId: z.string(), focus: z.enum(["primary", "secondary", "tertiary"]) }).strict() }, async (payload) => {
    try { return toolResult(await service.execute(parseCommand({ action: "assign", payload }))); } catch (error) { return toolError(error); }
  });
  server.registerTool("tasks_set_workflow_state", { description: "Archive or restore a task.", inputSchema: z.object({ id: z.string(), state: z.enum(["active", "archived"]), outcome: z.enum(["completed", "cancelled", "superseded"]).optional(), expectedRevision: z.number().int().positive().optional() }).strict() }, async ({ state, ...payload }) => {
    try { return toolResult(await service.execute(parseCommand({ action: state === "archived" ? "archiveTask" : "restoreTask", payload: state === "active" ? { id: payload.id, expectedRevision: payload.expectedRevision } : payload }))); } catch (error) { return toolError(error); }
  });
  if (backups) registerBackupTools(server, backups);
  return server;
}

function registerBackupTools(server: McpServer, backups: BackupService) {
  server.registerTool("backup_create", { description: "Create and verify an on-demand local database backup.", inputSchema: z.object({ reason: z.string().trim().min(1).max(32).optional() }).strict() }, async ({ reason }) => {
    try { return toolResult(await backups.create({ reason: reason ?? "manual" })); } catch (error) { return toolError(error); }
  });
  server.registerTool("backup_list", { description: "List verified local backups, newest first.", inputSchema: z.object({}).strict() }, async () => {
    try { return toolResult(await backups.list()); } catch (error) { return toolError(error); }
  });
  server.registerTool("backup_verify", { description: "Re-verify a backup's checksum and schema fingerprint.", inputSchema: z.object({ backupId: backupIdSchema }).strict() }, async (payload) => {
    try { return toolResult(await backups.verify(payload)); } catch (error) { return toolError(error); }
  });
  server.registerTool("backup_restore", { description: "Restore a verified backup. Requires confirmation text 'RESTORE:<backupId>' and creates a pre-restore safety backup first.", inputSchema: z.object({ backupId: backupIdSchema, confirmation: z.string().min(1), expectedCurrentRevision: z.string().optional() }).strict() }, async (payload) => {
    try { await backups.restore(payload); return toolResult({ restored: true }); } catch (error) { return toolError(error); }
  });
  server.registerTool("backup_delete", { description: "Delete a backup. Refuses to remove the last known-good backup.", inputSchema: z.object({ backupId: backupIdSchema }).strict() }, async (payload) => {
    try { await backups.delete(payload); return toolResult({ deleted: true }); } catch (error) { return toolError(error); }
  });
}

function toolName(action: string) {
  return ({ addPerson: "people_create", updatePerson: "people_update", deletePerson: "people_delete", reorderPeople: "people_reorder", addTask: "tasks_create", updateTask: "tasks_update", reorderTasks: "tasks_reorder", deleteTask: "tasks_delete", archiveTask: "tasks_archive", restoreTask: "tasks_restore", assign: "assignments_assign", unassign: "assignments_unassign", updateFocusSettings: "settings_update_focus" } as Record<string, string>)[action] ?? action;
}
function jsonResource(uri: string, value: unknown) { return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }] }; }
function toolResult(value: unknown) {
  // The protocol requires structuredContent to be an object; list-shaped results wrap their array under `items`.
  const structuredContent = (Array.isArray(value) ? { items: value } : value) as Record<string, unknown>;
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent };
}
function toolError(error: unknown) {
  const safe = error instanceof ApplicationError ? error.toJSON() : { code: "INTERNAL", message: "The command could not be completed." };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(safe) }] };
}
