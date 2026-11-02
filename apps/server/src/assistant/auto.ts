import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, assistantFile, assistantSettings, assistantThread, configProject, projectFile } from "@confire/db";
import { getUserState } from "../ui-views.ts";

// Auto mode (b1-tools spec §5.3): whether a b1.write/b1.copy posts at once or answers a proposal the
// user posts with a click. Read on every write, never sent by the client with one.

/** The user's own switch, a `ui_user_state` entry the chat box's toggle writes (views.setState). */
export const AUTO_WRITE_KEY = "assistant:autoWrite";

export const workspaceAutoWrite = async (tenantId: string): Promise<boolean> => {
  const [s] = await db.select({ on: assistantSettings.b1AutoWrite }).from(assistantSettings)
    .where(eq(assistantSettings.tenantId, tenantId)).limit(1);
  return !!s?.on;
};

export const userAutoWrite = async (tenantId: string, userId: string): Promise<boolean> =>
  (await getUserState(tenantId, userId, AUTO_WRITE_KEY)) === true;

/** The tools whose answer can carry text a client wrote: a client's request lists (their names), and
 *  — named by the input field holding the configuration — any configuration that is a client's
 *  request (its entries, its comments on the timeline, its name). Read by the chat's guard (route.ts). */
export const CLIENT_CONTENT_TOOLS: ReadonlySet<string> = new Set(["requests_rows"]);
export const CLIENT_PROJECT_TOOLS: Readonly<Record<string, string>> = {
  configs_get: "id", configs_calculate: "id", configs_select: "id", configs_similar: "id",
  propose_quotation: "projectId", timeline_list: "projectId",
};

/** A configuration that is a client's request (portal), in this workspace. */
export async function isClientProject(tenantId: string, projectId: unknown): Promise<boolean> {
  if (typeof projectId !== "string" || !/^[0-9a-f-]{36}$/i.test(projectId)) return false;
  const [p] = await db.select({ id: configProject.id }).from(configProject)
    .where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId), isNotNull(configProject.portalCardCode))).limit(1);
  return !!p;
}

/** Whether a tool call reads content a client wrote (before it runs: the guard taints the run first,
 *  so a write later in the same step already sees it). */
export async function readsClientContent(tenantId: string, toolName: string, args: unknown): Promise<boolean> {
  if (CLIENT_CONTENT_TOOLS.has(toolName)) return true;
  const field = CLIENT_PROJECT_TOOLS[toolName];
  return !!field && isClientProject(tenantId, (args as Record<string, unknown> | null)?.[field]);
}

/** The chat holds client content: a drop in the thread, any file of its configuration (the portal
 *  client's uploads included), a configuration that is a client's request, or an earlier run that read
 *  something a client wrote (its assistant messages carry `clientContent`, route.ts). That is where
 *  text written to steer the model comes from. */
export async function chatHasClientContent(tenantId: string, userId: string, threadId: string): Promise<boolean> {
  const [t] = await db.select({
    projectId: assistantThread.projectId,
    read: sql<boolean>`exists (select 1 from jsonb_array_elements(${assistantThread.messages}) m where m->'metadata'->>'clientContent' = 'true')`,
  }).from(assistantThread)
    .where(and(eq(assistantThread.id, threadId), eq(assistantThread.tenantId, tenantId), eq(assistantThread.userId, userId)))
    .limit(1);
  // A thread that is not this user's is no reason to post: fail closed.
  if (!t) return true;
  if (t.read) return true;
  const [drop] = await db.select({ id: assistantFile.id }).from(assistantFile)
    .where(and(eq(assistantFile.threadId, threadId), eq(assistantFile.tenantId, tenantId))).limit(1);
  if (drop) return true;
  if (!t.projectId) return false;
  if (await isClientProject(tenantId, t.projectId)) return true;
  const [file] = await db.select({ id: projectFile.id }).from(projectFile)
    .where(and(eq(projectFile.tenantId, tenantId), eq(projectFile.projectId, t.projectId))).limit(1);
  return !!file;
}

/** Both switches on, and none of the exceptions: no client content in the chat (files, a client's
 *  request, a read of what a client wrote — this run's or an earlier one's), not an Invoice copy (it
 *  posts to the accounts and is undone only by a credit memo), not an MCP call — Confire cannot see
 *  what an external AI read, so over MCP every write is a proposal the user confirms (spec §4.10).
 *  No thread and no MCP = a browser call: no exception. */
export async function autoWrite(
  c: { tenantId: string; userId: string; assistantThreadId?: string; assistantClientContent?: boolean; mcpUserId?: string },
  o: { target: string },
): Promise<boolean> {
  if (o.target === "Invoices" || c.mcpUserId || c.assistantClientContent) return false;
  if (!(await workspaceAutoWrite(c.tenantId)) || !(await userAutoWrite(c.tenantId, c.userId))) return false;
  return !c.assistantThreadId || !(await chatHasClientContent(c.tenantId, c.userId, c.assistantThreadId));
}
