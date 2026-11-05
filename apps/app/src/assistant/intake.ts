import type { UIMessage } from "@tanstack/ai-react";
import { FILE_MAX_MB, uploadAssistantFile, uploadFile } from "@confire/ui/files.ts";
import { client } from "../orpc.ts";

// A drop (assistant spec §4.1): on a configuration's chat its files go onto that configuration and are
// read into it at once (`extractDrop`); anywhere else they go into the user's thread and ride the
// user's words as one chat turn (`uploadDrop`, route.ts `refs`), and the chat decides what they are
// for — a request to quote, a report to rebuild, or neither.

/** What the assistant reads, by the browser's type or the name's extension (a CSV's type is often
 *  empty). The server tells by the bytes; this only spares an upload it would refuse. */
export const READABLE = [
  "application/pdf", "image/png", "image/jpeg",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.spreadsheet", "text/csv",
];
const READABLE_NAME = /\.(pdf|png|jpe?g|xlsx|xls|ods|csv)$/i;
/** The file picker's `accept`: the types and the extensions. */
export const ACCEPT = [...READABLE, ".xlsx", ".xls", ".ods", ".csv"].join(",");

export type DropError = { code: "FILE_MAX" | "TYPE" } | null;
export type FileRef = { kind: "assistant" | "project"; id: string; name: string; mime: string };

/** Why the browser refuses a file before sending it, or null. */
export function refuseFile(f: File): DropError {
  if (f.size > FILE_MAX_MB * 1024 * 1024) return { code: "FILE_MAX" };
  if (!READABLE.includes(f.type) && !READABLE_NAME.test(f.name)) return { code: "TYPE" };
  return null;
}

export async function extractDrop(a: { projectId: string; threadId: string; files: File[]; text: string }): Promise<UIMessage[]> {
  const projectId = a.projectId;
  // Internal-only on a client's request: the client's copy is theirs; these are the staff's reading.
  const refs = await Promise.all(a.files.map(async (f) => ({
    kind: "project" as const, id: (await uploadFile(projectId, f, true)).id, name: f.name, mime: f.type,
  })));
  return (await client.assistant.extract({ threadId: a.threadId, projectId, text: a.text, refs })).messages as UIMessage[];
}

export async function uploadDrop(threadId: string, files: File[]): Promise<FileRef[]> {
  return Promise.all(files.map(async (f) => (await uploadAssistantFile(threadId, f)).ref));
}

/** A part's file as a stored thread carries it: a PDF or an image part, or a spreadsheet's text part
 *  (read as text by the server, emptied when stored). */
export function fileOfPart(p: UIMessage["parts"][number]): { title: string; file?: FileRef } | null {
  if (p.type !== "document" && p.type !== "image" && p.type !== "text") return null;
  const meta = (p as { metadata?: unknown }).metadata as { title?: string; file?: FileRef } | undefined;
  if (p.type === "text" && !meta?.file) return null;
  return { title: meta?.title ?? meta?.file?.name ?? "", ...(meta?.file ? { file: meta.file } : {}) };
}

/** A file's icon by its type. */
export const fileIcon = (mime: string): string =>
  mime === "application/pdf" ? "pdf-attachment" : mime.startsWith("image/") ? "attachment-photo" : "excel-attachment";
