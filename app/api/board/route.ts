import { env } from "cloudflare:workers";
import { z } from "zod";

type Focus = "primary" | "secondary" | "tertiary";
type TaskStatus = "active" | "hold" | "archived";

const MAX_BODY_BYTES = 16 * 1024;
const id = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "Invalid identifier.");
const color = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Invalid color.");
const shortText = (label: string, maximum: number) => z.string().trim().min(1, `${label} is required.`).max(maximum);
const optionalText = (maximum: number) => z.string().trim().max(maximum).optional().default("");

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("addPerson"), payload: z.object({ name: shortText("A name", 100), role: optionalText(160), color: color.optional() }).strict() }),
  z.object({ action: z.literal("updatePerson"), payload: z.object({ id, name: shortText("A name", 100), role: optionalText(160), color: color.optional() }).strict() }),
  z.object({ action: z.literal("deletePerson"), payload: z.object({ id }).strict() }),
  z.object({ action: z.literal("addTask"), payload: z.object({ title: shortText("A task title", 200), description: optionalText(2_000), category: optionalText(100), color: color.optional() }).strict() }),
  z.object({ action: z.literal("updateTask"), payload: z.object({ id, title: shortText("A task title", 200), description: optionalText(2_000), category: optionalText(100), color: color.optional() }).strict() }),
  z.object({ action: z.literal("setTaskStatus"), payload: z.object({ id, status: z.enum(["active", "hold", "archived"]) }).strict() }),
  z.object({ action: z.literal("deleteTask"), payload: z.object({ id }).strict() }),
  z.object({ action: z.literal("assign"), payload: z.object({ taskId: id, personId: id, focus: z.enum(["primary", "secondary", "tertiary"]) }).strict() }),
  z.object({ action: z.literal("unassign"), payload: z.object({ taskId: id, personId: id }).strict() }),
]);

class ClientError extends Error {}

function db() {
  if (!env.DB) throw new Error("Private storage is unavailable.");
  return env.DB;
}

async function getState() {
  const store = db();
  const [peopleResult, tasksResult, assignmentsResult] = await store.batch([
    store.prepare("SELECT id, name, role, color, sort_order AS sortOrder FROM people ORDER BY sort_order, created_at"),
    store.prepare("SELECT id, title, description, category, color, status, created_at AS createdAt, updated_at AS updatedAt FROM tasks ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'hold' THEN 1 ELSE 2 END, updated_at DESC"),
    store.prepare("SELECT id, task_id AS taskId, person_id AS personId, focus, created_at AS createdAt FROM assignments ORDER BY created_at"),
  ]);
  return { people: peopleResult.results, tasks: tasksResult.results, assignments: assignmentsResult.results, savedAt: new Date().toISOString() };
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

async function applyAction(action: string, payload: Record<string, unknown>) {
  const store = db();
  switch (action) {
    case "addPerson": {
      const name = text(payload.name);
      const result = await store.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM people").first<{ value: number }>();
      await store.prepare("INSERT INTO people (id, name, role, color, sort_order) VALUES (?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), name, text(payload.role), text(payload.color, "#2f6f65"), result?.value ?? 0).run();
      break;
    }
    case "updatePerson": {
      const name = text(payload.name);
      await store.prepare("UPDATE people SET name = ?, role = ?, color = ? WHERE id = ?")
        .bind(name, text(payload.role), text(payload.color, "#2f6f65"), payload.id).run();
      break;
    }
    case "deletePerson":
      await store.prepare("DELETE FROM people WHERE id = ?").bind(payload.id).run();
      break;
    case "addTask": {
      const title = text(payload.title);
      await store.prepare("INSERT INTO tasks (id, title, description, category, color) VALUES (?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), title, text(payload.description), text(payload.category, "General") || "General", text(payload.color, "#5b67a5")).run();
      break;
    }
    case "updateTask": {
      const title = text(payload.title);
      await store.prepare("UPDATE tasks SET title = ?, description = ?, category = ?, color = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(title, text(payload.description), text(payload.category, "General") || "General", text(payload.color, "#5b67a5"), payload.id).run();
      break;
    }
    case "setTaskStatus": {
      const status = payload.status as TaskStatus;
      await store.prepare("UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(status, payload.id).run();
      break;
    }
    case "deleteTask":
      await store.prepare("DELETE FROM tasks WHERE id = ?").bind(payload.id).run();
      break;
    case "assign": {
      const focus = payload.focus as Focus;
      const task = await store.prepare("SELECT status FROM tasks WHERE id = ?").bind(payload.taskId).first<{ status: TaskStatus }>();
      if (!task || task.status === "archived") throw new ClientError("Archived tasks cannot be assigned.");
      const upsert = store.prepare("INSERT INTO assignments (id, task_id, person_id, focus) VALUES (?, ?, ?, ?) ON CONFLICT(task_id, person_id) DO UPDATE SET focus = excluded.focus, created_at = CURRENT_TIMESTAMP")
        .bind(crypto.randomUUID(), payload.taskId, payload.personId, focus);
      if (focus === "primary") {
        await store.batch([store.prepare("DELETE FROM assignments WHERE task_id = ? AND focus = 'primary' AND person_id <> ?").bind(payload.taskId, payload.personId), upsert]);
      } else await upsert.run();
      break;
    }
    case "unassign":
      await store.prepare("DELETE FROM assignments WHERE task_id = ? AND person_id = ?").bind(payload.taskId, payload.personId).run();
      break;
    default:
      throw new ClientError("Unknown action.");
  }
}

export async function GET(request: Request) {
  try {
    const state = await getState();
    if (new URL(request.url).searchParams.get("export") === "1") {
      return new Response(JSON.stringify(state, null, 2), { headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename=\"work-distribution-${new Date().toISOString().slice(0, 10)}.json\"`,
      }});
    }
    return Response.json(state);
  } catch (error) {
    console.error("Could not load the board.", error);
    return Response.json({ error: "Could not load the board." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_BODY_BYTES) return Response.json({ error: "Request body is too large." }, { status: 413 });
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) return Response.json({ error: "Request body is too large." }, { status: 413 });
    let input: unknown;
    try { input = JSON.parse(rawBody); } catch { throw new ClientError("Request body must be valid JSON."); }
    const parsed = actionSchema.safeParse(input);
    if (!parsed.success) throw new ClientError(parsed.error.issues[0]?.message ?? "Invalid request.");
    await applyAction(parsed.data.action, parsed.data.payload);
    return Response.json(await getState());
  } catch (error) {
    if (error instanceof ClientError) return Response.json({ error: error.message }, { status: 400 });
    console.error("Could not save that change.", error);
    return Response.json({ error: "Could not save that change." }, { status: 500 });
  }
}
