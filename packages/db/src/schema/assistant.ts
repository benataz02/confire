import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bytea, configProject } from "./configurator.ts";

// The assistant (spec docs/superpowers/specs/2026-10-24-ai-assistant-design.md §4.7): the workspace
// switch, the chat threads and their dropped files, and the meter. Written only by
// apps/server/src/assistant/.

/** The workspace switch, off until an admin turns it on. A column, not a jsonb document: the chat
 *  route filters on it. Phase 3 adds the `mcp` switch beside it. */
export const assistantSettings = pgTable("assistant_settings", {
  tenantId: text("tenant_id").primaryKey(),
  assistant: boolean("assistant").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// One thread per (user, configuration), plus the user's general threads (`projectId` null).
// `messages` is TanStack AI's ModelMessage[], typed loosely so this package takes no @tanstack/ai
// dependency (threads.ts casts at its boundary). Append-only: Sonnet 5.5 refuses edited history
// (preserved thinking), so nothing rewrites or deletes a stored message. `busyUntil` is the one-run
// lease (`withThread`). Stored file parts carry a reference, never their bytes.
export const assistantThread = pgTable(
  "assistant_thread",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    projectId: uuid("project_id").references(() => configProject.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    messages: jsonb("messages").$type<Record<string, unknown>[]>().notNull().default([]),
    busyUntil: timestamp("busy_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("assistant_thread_project_uq").on(t.tenantId, t.userId, t.projectId).where(sql`${t.projectId} is not null`),
    index("assistant_thread_user_idx").on(t.tenantId, t.userId, t.updatedAt),
  ],
);

/** A thread's dropped files before a configuration exists; `assistant.start` copies them into
 *  `project_file` through `addFile`. */
export const assistantFile = pgTable("assistant_file", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: text("tenant_id").notNull(),
  threadId: uuid("thread_id").notNull().references(() => assistantThread.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  data: bytea("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AiUsageKind = "extract" | "chat";

// The meter: one row per model call. No foreign keys on purpose — a billing row outlives its thread
// and its project. An "assisted configuration" is a distinct projectId here.
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    threadId: uuid("thread_id"),
    projectId: uuid("project_id"),
    model: text("model").notNull(),
    kind: text("kind").$type<AiUsageKind>().notNull(),
    /** uncached input tokens; the cache parts are their own columns */
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    /** USD, from the price table in apps/server/src/assistant/usage.ts */
    cost: numeric("cost", { precision: 12, scale: 6 }).notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_usage_tenant_at_idx").on(t.tenantId, t.at)],
);
