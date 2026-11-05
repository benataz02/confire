import { Hono } from "hono";
import { z } from "zod";
import { ORPCError } from "@orpc/server";
import type { ContentPart } from "@tanstack/ai";
import { and, eq, inArray } from "drizzle-orm";
import { db, assistantFile, assistantThread, projectFile } from "@confire/db";
import { cleanName, FILE_MAX, handle, imageType, readCapped, UUID, whoFor } from "../files.ts";
import { addFile, type Actor } from "../project-lifecycle.ts";
import { cachedSheetText, isSheet } from "./sheet.ts";
import { t as text } from "../i18n/index.ts";

// The files the assistant reads (assistant spec §4.2, §4.9): a configuration's own (`project_file`)
// and, before a configuration exists, a thread's drop (`assistant_file`). PDF, PNG and JPEG, which
// Claude reads as they are, and spreadsheets, which it reads as text (sheet.ts) — told by their bytes,
// never by a claimed type (a CSV, which has no magic bytes, by its name and its being text).

export type DocType = "application/pdf" | "image/png" | "image/jpeg";
export const docType = (b: Buffer): DocType | null =>
  b.subarray(0, 5).toString("latin1") === "%PDF-" ? "application/pdf" : imageType(b);

const SHEET_MIME: Record<string, string> = {
  xls: "application/vnd.ms-excel", ods: "application/vnd.oasis.opendocument.spreadsheet", csv: "text/csv",
};
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** The type the assistant reads the bytes as, or null when it reads none of them. A spreadsheet's
 *  type is only its label (by its extension): what the bytes are decided whether it is one. */
export function readableType(b: Buffer, name: string): string | null {
  return docType(b) ?? (isSheet(b, name) ? SHEET_MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? XLSX_MIME : null);
}

/** A file as a thread stores it: a reference, never its bytes. */
export type FileRef = { kind: "assistant" | "project"; id: string; name: string; mime: string };
export const FileRefZ = z.object({ kind: z.enum(["assistant", "project"]), id: z.uuid(), name: z.string().min(1), mime: z.string() });

/** Raw bytes per model call: Claude takes 32 MB a request, and base64 grows the bytes by 4/3. */
export const REQUEST_FILE_CAP = 24 * 1024 * 1024;

/** A file part's Confire metadata: the adapter forwards `title` only. */
export type FileMeta = { title: string; file: FileRef };

/** Where a call's refs may point beyond the tenant: a project's files to that project (none without
 *  one), a drop's to that thread — so a crafted ref cannot read a colleague's drop or a client's draft. */
export type Fence = { projectId?: string; threadId?: string };

/** The bytes behind refs, fenced by tenant and `fence`. Sizes are summed before any byte is read, so
 *  a refused request never loads them. */
export async function fileBytes(tenantId: string, refs: FileRef[], fence: Fence = {}): Promise<Map<string, Buffer>> {
  const { projectId, threadId } = fence;
  const ids = (kind: FileRef["kind"]) => refs.filter((r) => r.kind === kind).map((r) => r.id);
  const pIds = ids("project");
  const aIds = ids("assistant");
  // A configuration's file only with that configuration named: tenant alone would let a crafted ref
  // read any configuration's files, a client's private draft included.
  const pFence = pIds.length && projectId ? and(eq(projectFile.tenantId, tenantId), inArray(projectFile.id, pIds), eq(projectFile.projectId, projectId)) : null;
  const aFence = aIds.length ? and(eq(assistantFile.tenantId, tenantId), inArray(assistantFile.id, aIds), threadId ? eq(assistantFile.threadId, threadId) : undefined) : null;
  const sizes = [
    ...(pFence ? await db.select({ size: projectFile.size }).from(projectFile).where(pFence) : []),
    ...(aFence ? await db.select({ size: assistantFile.size }).from(assistantFile).where(aFence) : []),
  ];
  const total = sizes.reduce((n, r) => n + r.size, 0);
  if (total > REQUEST_FILE_CAP)
    throw new ORPCError("PAYLOAD_TOO_LARGE", { message: text("ASSISTANT_FILES_TOO_LARGE", Math.ceil(total / 2 ** 20), REQUEST_FILE_CAP / 2 ** 20) });
  const rows = [
    ...(pFence ? await db.select({ id: projectFile.id, data: projectFile.data }).from(projectFile).where(pFence) : []),
    ...(aFence ? await db.select({ id: assistantFile.id, data: assistantFile.data }).from(assistantFile).where(aFence) : []),
  ];
  return new Map(rows.map((r) => [r.id, r.data]));
}

/** One file as the model reads it, or null when its bytes are no type the assistant reads. A
 *  spreadsheet is a text part (Claude's documents are PDFs) carrying its file the same way. */
export function filePart(ref: FileRef, data: Buffer): ContentPart | null {
  const mime = docType(data);
  if (!mime) {
    const text = cachedSheetText(ref.id, ref.name, data);
    return text === null ? null : { type: "text", content: text, metadata: { title: ref.name, file: ref } satisfies FileMeta };
  }
  const source = { type: "data" as const, value: data.toString("base64"), mimeType: mime };
  const metadata: FileMeta = { title: ref.name, file: { ...ref, mime } };
  return mime === "application/pdf" ? { type: "document", source, metadata } : { type: "image", source, metadata };
}

/**
 * The refs as content parts, each named by a text part before it: an image has no title on the wire,
 * and a value's source names its file. Unreadable types and refs outside the fence are skipped.
 */
export async function fileParts(tenantId: string, refs: FileRef[], fence: Fence = {}): Promise<ContentPart[]> {
  const bytes = await fileBytes(tenantId, refs, fence);
  return refs.flatMap((ref) => {
    const data = bytes.get(ref.id);
    const part = data && filePart(ref, data);
    return part ? [{ type: "text" as const, content: `File: ${ref.name}`, metadata: { fileLabel: true } }, part] : [];
  });
}

/**
 * Parts as the model is sent them: every text part without its metadata (a file label's `fileLabel`,
 * a turn's `pageContext`), which only Confire reads. The adapter spreads a text part's metadata onto
 * the wire block (an image's or a document's it picks), and Claude refuses a field it does not know —
 * "messages.0.content.0.text.fileLabel: Extra inputs are not permitted" (400, verified 2026-11-02).
 * The stored part keeps it.
 */
export const unlabeled = (parts: ContentPart[]): ContentPart[] =>
  parts.map((p) => (p.type === "text" && p.metadata ? { type: "text", content: p.content } : p));

/** The drop's upload, past the RPC body cap: `POST /files/<slug>/assistant/<threadId>?name=`, the
 *  raw body. Staff only, into their own thread; ≤ 10 MB, a type `readableType` reads. Mounted by
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
    if (!data) throw new ORPCError("PAYLOAD_TOO_LARGE", { message: text("FILE_TOO_LARGE") });
    const name = cleanName(c.req.query("name"));
    const mime = readableType(data, name);
    if (!mime) throw new ORPCError("UNSUPPORTED_MEDIA_TYPE", { message: text("ASSISTANT_FILE_TYPE") });
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
