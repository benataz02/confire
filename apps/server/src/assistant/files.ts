import { ORPCError } from "@orpc/server";
import type { ContentPart } from "@tanstack/ai";
import { and, eq, inArray } from "drizzle-orm";
import { db, projectFile } from "@confire/db";
import { imageType } from "../files.ts";

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

/** The bytes behind refs, fenced by tenant (and by project when given). Sizes are summed before any
 *  byte is read, so a refused request never loads them. */
export async function fileBytes(tenantId: string, refs: FileRef[], projectId?: string): Promise<Map<string, Buffer>> {
  const ids = refs.filter((r) => r.kind === "project").map((r) => r.id);
  if (!ids.length) return new Map();
  const fence = and(eq(projectFile.tenantId, tenantId), inArray(projectFile.id, ids), projectId ? eq(projectFile.projectId, projectId) : undefined);
  const sizes = await db.select({ size: projectFile.size }).from(projectFile).where(fence);
  const total = sizes.reduce((n, r) => n + r.size, 0);
  if (total > REQUEST_FILE_CAP)
    throw new ORPCError("PAYLOAD_TOO_LARGE", { message: `The files come to ${Math.ceil(total / 2 ** 20)} MB; the assistant reads up to ${REQUEST_FILE_CAP / 2 ** 20} MB at a time` });
  const rows = await db.select({ id: projectFile.id, data: projectFile.data }).from(projectFile).where(fence);
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
    return part ? [{ type: "text" as const, content: `File: ${ref.name}` }, part] : [];
  });
}
