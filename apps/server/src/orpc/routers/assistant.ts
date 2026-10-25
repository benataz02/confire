import { ORPCError } from "@orpc/server";
import { modelMessagesToUIMessages, type ContentPart, type ModelMessage } from "@tanstack/ai";
import { z } from "zod";
import { db, assistantSettings } from "@confire/db";
import { adminProcedure, userProcedure } from "../base.ts";
import { createProject, Customer } from "./configs.ts";
import { extractInto } from "../../assistant/extract.ts";
import { copyToProject, fileParts, type FileRef } from "../../assistant/files.ts";
import { readRequest } from "../../assistant/intake.ts";
import { ASSISTANT_MODEL, available } from "../../assistant/model.ts";
import {
  appendMessages, dehydrate, lastDrop, linkProject, newThread, ownThread, threadFor, withThread, type Thread,
} from "../../assistant/threads.ts";
import { assertAssistant, assistantOn, MONTHLY_LIMIT_USD, monthUsage, rateLimit } from "../../assistant/usage.ts";

// The assistant's fixed steps (spec §4.1), called by the panel: read the request (`intake`), start
// the configuration it proposes (`start`, no model call), read its values (`extract`). Each step's
// result is written into the thread as a tool call and its result, so the chat and the panel read
// one history and the chat model can refer back to them. The chat itself is assistant/route.ts.

const FileRefZ = z.object({
  kind: z.enum(["assistant", "project"]),
  id: z.uuid(),
  name: z.string().min(1),
  mime: z.string(),
});

const isAdmin = (role: string) => role === "admin" || role === "owner";

/** One step's call and result, as the chat model would have made them. */
function toolPair(name: string, result: unknown): ModelMessage[] {
  const id = `${name}_${crypto.randomUUID()}`;
  return [
    { role: "assistant", content: null, toolCalls: [{ id, type: "function", function: { name, arguments: "{}" } }] },
    { role: "tool", toolCallId: id, content: JSON.stringify(result) },
  ];
}

const userMessage = (parts: ContentPart[], text: string): ModelMessage => ({
  role: "user", content: [...parts, ...(text.trim() ? [{ type: "text" as const, content: text }] : [])],
});

/** Store, then answer what was stored, as the panel draws it: no file bytes either way. */
async function append(threadId: string, msgs: ModelMessage[], title?: string) {
  const stored = msgs.map(dehydrate);
  await appendMessages(threadId, stored, title);
  return modelMessagesToUIMessages(stored);
}

/** A general thread's configuration: created `via` the assistant, the thread linked to it (and
 *  `thread.projectId` set, for the rest of a chat run), the last drop copied in as its files. */
export async function startFromThread(
  ctx: { tenantId: string; userId: string }, t: Thread,
  input: { modelId: string; name: string; customer?: z.infer<typeof Customer> | null },
): Promise<{ id: string }> {
  if (t.projectId) throw new ORPCError("BAD_REQUEST", { message: "This chat already belongs to a configuration" });
  const { id } = await createProject(ctx.tenantId, ctx.userId, input, "assistant");
  await linkProject(t.id, id);
  t.projectId = id;
  const drop = lastDrop(t.messages);
  if (drop) await copyToProject(ctx.tenantId, id, { userId: ctx.userId, side: "internal" }, drop.refs);
  return { id };
}

export const assistantRouter = {
  /** The panel's empty state: on, over budget, and whether to show the Settings link. Never throws. */
  status: userProcedure.handler(async ({ context }) => {
    const enabled = available() && await assistantOn(context.tenantId);
    return {
      enabled,
      limitReached: (await monthUsage(context.tenantId)).cost >= MONTHLY_LIMIT_USD,
      isAdminHint: isAdmin(context.role),
    };
  }),

  /** This user's thread for a configuration, or their latest general one. */
  thread: userProcedure
    .input(z.object({ projectId: z.uuid().optional() }))
    .handler(async ({ input, context }) => {
      const t = await threadFor(context.tenantId, context.userId, input.projectId ?? null);
      return { id: t.id, projectId: t.projectId, messages: modelMessagesToUIMessages(t.messages) };
    }),

  newThread: userProcedure.handler(async ({ context }) => ({ id: (await newThread(context.tenantId, context.userId)).id })),

  /** Read a drop: propose model, customer and name. Nothing is created. */
  intake: userProcedure
    .input(z.object({ threadId: z.uuid(), text: z.string().max(50_000), refs: z.array(FileRefZ).min(1).max(10) }))
    .handler(async ({ input, context }) => {
      const t = await ownThread(context.tenantId, context.userId, input.threadId);
      return withThread(t.id, async () => {
        await assertAssistant(context.tenantId);
        rateLimit(context.userId);
        const parts = await fileParts(context.tenantId, input.refs as FileRef[], { threadId: t.id, ...(t.projectId ? { projectId: t.projectId } : {}) });
        const proposal = await readRequest({ headers: context.headers, tenantId: context.tenantId }, {
          parts, text: input.text,
          meter: { tenantId: context.tenantId, userId: context.userId, threadId: t.id, projectId: t.projectId, kind: "extract" },
        });
        const messages = await append(t.id, [userMessage(parts, input.text), ...toolPair("read_request", proposal)], proposal.name);
        return { messages, proposal };
      });
    }),

  /** Create the confirmed configuration from a general thread: the thread becomes its thread, and the
   *  drop becomes its files. No model call. */
  start: userProcedure
    .input(z.object({ threadId: z.uuid(), modelId: z.uuid(), name: z.string().trim().min(1), customer: Customer.nullable() }))
    .handler(async ({ input, context }) => {
      rateLimit(context.userId);
      return startFromThread(context, await ownThread(context.tenantId, context.userId, input.threadId), input);
    }),

  /** Read values into the thread's configuration: the files and text given, or the last drop. */
  extract: userProcedure
    .input(z.object({
      threadId: z.uuid(), projectId: z.uuid(),
      text: z.string().max(50_000).optional(), refs: z.array(FileRefZ).max(10).optional(),
    }))
    .handler(async ({ input, context }) => {
      const t = await ownThread(context.tenantId, context.userId, input.threadId);
      if (t.projectId !== input.projectId) throw new ORPCError("BAD_REQUEST", { message: "This chat belongs to another configuration" });
      return withThread(t.id, async () => {
        rateLimit(context.userId);
        const given = !!input.text?.trim() || !!input.refs?.length;
        const drop = given ? { refs: (input.refs ?? []) as FileRef[], text: input.text ?? "" } : lastDrop(t.messages);
        if (!drop) throw new ORPCError("BAD_REQUEST", { message: "Nothing to read: drop the client's files first" });
        const result = await extractInto(
          { headers: context.headers, tenantId: context.tenantId, userId: context.userId, threadId: t.id }, input.projectId, drop,
        );
        const user = given ? [userMessage(await fileParts(context.tenantId, drop.refs, { projectId: input.projectId, threadId: t.id }), drop.text)] : [];
        return { messages: await append(t.id, [...user, ...toolPair("extract_values", result)]), result };
      });
    }),

  settings: adminProcedure.handler(async ({ context }) => ({ assistant: await assistantOn(context.tenantId) })),

  saveSettings: adminProcedure
    .input(z.object({ assistant: z.boolean() }))
    .handler(async ({ input, context }) => {
      await db.insert(assistantSettings).values({ tenantId: context.tenantId, assistant: input.assistant })
        .onConflictDoUpdate({ target: assistantSettings.tenantId, set: { assistant: input.assistant, updatedAt: new Date() } });
      return { assistant: input.assistant };
    }),

  /** This month's spend against the limit, and the configurations it went to. */
  usage: adminProcedure.handler(async ({ context }) => ({
    ...(await monthUsage(context.tenantId)), limit: MONTHLY_LIMIT_USD, model: ASSISTANT_MODEL,
  })),
};
