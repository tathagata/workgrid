import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const people = sqliteTable("people", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").notNull().default(""),
  color: text("color").notNull().default("#2f6f65"),
  colorId: text("color_id"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const boardMetadata = sqliteTable("board_metadata", {
  id: integer("id").primaryKey(),
  revision: integer("revision").notNull().default(1),
});

export const boardSettings = sqliteTable("board_settings", {
  id: integer("id").primaryKey(),
  overfocusThreshold: real("overfocus_threshold").notNull().default(2.5),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  category: text("category").notNull().default("General"),
  color: text("color").notNull().default("#5b67a5"),
  colorId: text("color_id"),
  lifecycle: text("lifecycle", { enum: ["active", "archived"] }).notNull().default("active"),
  outcome: text("outcome", { enum: ["completed", "cancelled", "superseded"] }),
  workflowChangedAt: text("workflow_changed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revision: integer("revision").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
  legacyStatus: text("legacy_status", { enum: ["active", "hold", "archived"] }),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const assignments = sqliteTable("assignments", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  personId: text("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  focus: text("focus", { enum: ["primary", "secondary", "tertiary"] }).notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("assignments_task_person_unique").on(table.taskId, table.personId)]);

/** Lets a retried bulk-capture submission return its original result instead of duplicating tasks. */
export const idempotencyKeys = sqliteTable("idempotency_keys", {
  key: text("key").primaryKey(),
  taskIds: text("task_ids").notNull(),
  revision: integer("revision").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
