import { Hono } from "hono";
import { ORPCError } from "@orpc/server";
import type { ContentPart } from "@tanstack/ai";
import { and, eq, inArray } from "drizzle-orm";
import { db, assistantFile, assistantThread, projectFile } from "@confire/db";
import { cleanName, FILE_MAX, handle, imageType, readCapped, UUID, whoFor } from "../files.ts";
import { addFile, type Actor } from "../project-lifecycle.ts";

// The files the assistant reads (assistant spec §4.2, §4.9): a configuration's own (`project_file`)
// and, before a configuration exists, a thread's drop (`assistant_file`). Only PDF, PNG and JPEG,
// told by their bytes, never by a name or a claimed type.

export type DocType = "application/pdf" | "image/png" | "image/jpeg";
export const docType = (b: Buffer): DocType | null =>
  b.subarray(0, 5).toString("latin1") === "%PDF-" ? "application/pdf" : imageType(b);

/** A file as a thread stores it: a reference, never its bytes. */
export type FileRef = { kind: "assistant" | "project"; id: string; name: string; mime: string };

/** Raw bytes per model call: Claude takes 32 MB a request, and base64 grows the bytes by 4/3. */
export const REQUEST_FILE_CAP = 24 * 1024 * 1024;

/** A file part's Confire metadata: the adapter forwards `title` only. */
export type FileMeta = { title: string; file: FileRef };

/** The bytes behind refs, fenced by tenant (and a project's by that project when given). Sizes are
 *  summed before any byte is read, so a refused request never loads them. */
export async function fileBytes(tenantId: string, refs: FileRef[], projectId?: string): Promise<Map<string, Buffer>> {
  const ids = (kind: FileRef["kind"]) => refs.filter((r) => r.kind === kind).map((r) => r.id);
  const pIds = ids("project");
  const aIds = ids("assistant");
  const pFence = pIds.length ? and(eq(projectFile.tenantId, tenantId), inArray(projectFile.id, pIds), projectId ? eq(projectFile.projectId, projectId) : undefined) : null;
  const aFence = aIds.length ? and(eq(assistantFile.tenantId, tenantId), inArray(assistantFile.id, aIds)) : null;
  const sizes = [
    ...(pFence ? await db.select({ size: projectFile.size }).from(projectFile).where(pFence) : []),
    ...(aFence ? await db.select({ size: assistantFile.size }).from(assistantFile).where(aFence) : []),
  ];
  const total = sizes.reduce((n, r) => n + r.size, 0);
  if (total > REQUEST_FILE_CAP)
    throw new ORPCError("PAYLOAD_TOO_LARGE", { message: `The files come to ${Math.ceil(total / 2 ** 20)} MB; the assistant reads up to ${REQUEST_FILE_CAP / 2 ** 20} MB at a time` });
  const rows = [
    ...(pFence ? await db.select({ id: projectFile.id, data: projectFile.data }).from(projectFile).where(pFence) : []),
    ...(aFence ? await db.select({ id: assistantFile.id, data: assistantFile.data }).from(assistantFile).where(aFence) : []),
  ];
  return new Map(rows.map((r) => [r.id, r.data]));
}

/** One file as the model reads it, or null when its bytes are no type the assistant reads. */
export function filePart(ref: FileRef, data: Buffer): ContentPart | null {
  const mime = docType(data);
  if (!mime) return null;
  const source = { type: "data" as const, value: data.toString("base64"), mimeType: mime };
  const metadata: FileMeta = { title: ref.name, file: { ...ref, mime } };
  return mime === "application/pdf" ? { type: "document", source, metadata } : { type: "image", source, metadata };
}

/**
 * The refs as content parts, each named by a text part before it: an image has no title on the wire,
 * and a value's source names its file. Unreadable types and refs outside the fence are skipped.
 */
export async function fileParts(tenantId: string, refs: FileRef[], projectId?: string): Promise<ContentPart[]> {
  const bytes = await fileBytes(tenantId, refs, projectId);
  return refs.flatMap((ref) => {
    const data = bytes.get(ref.id);
    const part = data && filePart(ref, data);
    return part ? [{ type: "text" as const, content: `File: ${ref.name}`, metadata: { fileLabel: true } }, part] : [];
  });
}

/** The drop's upload, past the RPC body cap: `POST /files/<slug>/assistant/<threadId>?name=`, the
 *  raw body. Staff only, into their own thread; ≤ 10 MB, a PDF, PNG or JPEG by its bytes. Mounted by
 *  the staff process beside the project file routes. */
export function assistantFileRoutes(): Hono {
  const app = new Hono();
  app.post("/files/:tenant/assistant/:threadId", handle(async (c) => {
    const threadId = c.req.param("threadId")!;
    if (!UUID.test(threadId)) throw new ORPCError("NOT_FOUND");
    const who = await whoFor("internal", c);
    const [t] = await db.select({ id: assistantThread.id }).from(assistantThread).where(and(
      eq(assistantThread.id, threadId), eq(assistantThread.tenantId, who.tenantId), eq(assistantThread.userId, who.actor.userId!),
    )).limit(1);
    if (!t) throw new ORPCError("NOT_FOUND");
    const data = await readCapped(c.req.raw, FILE_MAX);
    if (!data) throw new ORPCError("PAYLOAD_TOO_LARGE", { message: "A file can be up to 10 MB" });
    const mime = docType(data);
    if (!mime) throw new ORPCError("UNSUPPORTED_MEDIA_TYPE", { message: "The assistant reads PDF, PNG and JPEG files" });
    const name = cleanName(c.req.query("name"));
    const [row] = await db.insert(assistantFile).values({ tenantId: who.tenantId, threadId, name, mime, size: data.length, data })
      .returning({ id: assistantFile.id });
    const ref: FileRef = { kind: "assistant", id: row!.id, name, mime };
    return c.json({ ref }, 201);
  }));
  return app;
}

/** A drop becomes the configuration's files: each assistant file through `addFile`, which writes its
 *  `file` event. Answers the refs as the configuration now holds them. */
export async function copyToProject(tenantId: string, projectId: string, actor: Actor, refs: FileRef[]): Promise<FileRef[]> {
  const bytes = await fileBytes(tenantId, refs.filter((r) => r.kind === "assistant"));
  const out: FileRef[] = [];
  for (const ref of refs) {
    const data = ref.kind === "assistant" ? bytes.get(ref.id) : undefined;
    if (ref.kind === "project") { out.push(ref); continue; }
    if (!data) continue;
    const { id } = await addFile(tenantId, projectId, actor, { name: ref.name, mime: ref.mime, data }, false);
    out.push({ kind: "project", id, name: ref.name, mime: ref.mime });
  }
  return out;
}
