import { and, eq } from "drizzle-orm";
import { db, assistantFile, assistantSettings, assistantThread, projectFile } from "@confire/db";
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

/** The chat holds client files: a drop in the thread, or any file of its configuration (the portal
 *  client's uploads included). That is where text written to steer the model comes from. */
export async function chatHasFiles(tenantId: string, userId: string, threadId: string): Promise<boolean> {
  const [t] = await db.select({ projectId: assistantThread.projectId }).from(assistantThread)
    .where(and(eq(assistantThread.id, threadId), eq(assistantThread.tenantId, tenantId), eq(assistantThread.userId, userId)))
    .limit(1);
  // A thread that is not this user's is no reason to post: fail closed.
  if (!t) return true;
  const [drop] = await db.select({ id: assistantFile.id }).from(assistantFile)
    .where(and(eq(assistantFile.threadId, threadId), eq(assistantFile.tenantId, tenantId))).limit(1);
  if (drop || !t.projectId) return !!drop;
  const [file] = await db.select({ id: projectFile.id }).from(projectFile)
    .where(and(eq(projectFile.tenantId, tenantId), eq(projectFile.projectId, t.projectId))).limit(1);
  return !!file;
}

/** Both switches on, and none of the exceptions: no client files in the chat, not an Invoice copy
 *  (it posts to the accounts and is undone only by a credit memo), not an MCP call — Confire cannot see
 *  what an external AI read, so over MCP every write is a proposal the user confirms (spec §4.10).
 *  No thread and no MCP = a browser call: no file exception. */
export async function autoWrite(
  c: { tenantId: string; userId: string; assistantThreadId?: string; mcpUserId?: string },
  o: { target: string },
): Promise<boolean> {
  if (o.target === "Invoices" || c.mcpUserId) return false;
  if (!(await workspaceAutoWrite(c.tenantId)) || !(await userAutoWrite(c.tenantId, c.userId))) return false;
  return !c.assistantThreadId || !(await chatHasFiles(c.tenantId, c.userId, c.assistantThreadId));
}
