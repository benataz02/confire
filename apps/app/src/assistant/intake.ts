import type { UIMessage } from "@tanstack/ai-react";
import { FILE_MAX_MB, uploadAssistantFile, uploadFile } from "@confire/ui/files.ts";
import { client } from "../orpc.ts";

// A drop (assistant spec §4.1 steps 1–3): on a configuration's page its files go onto that
// configuration and are read into it at once; anywhere else they go into the user's thread and the
// first, cheap call proposes model, customer and name. Either way the server answers the messages it
// appended, which the panel adds to the chat as they are.

/** What the assistant reads. The server sniffs the bytes; this only spares an upload it would refuse. */
export const READABLE = ["application/pdf", "image/png", "image/jpeg"];

export type DropError = { code: "FILE_MAX" | "TYPE" } | null;

/** Why the browser refuses a file before sending it, or null. */
export function refuseFile(f: File): DropError {
  if (f.size > FILE_MAX_MB * 1024 * 1024) return { code: "FILE_MAX" };
  if (!READABLE.includes(f.type)) return { code: "TYPE" };
  return null;
}

export async function sendDrop(a: { projectId: string | null; threadId: string; files: File[]; text: string }): Promise<UIMessage[]> {
  if (a.projectId) {
    const projectId = a.projectId;
    // Internal-only on a client's request: the client's copy is theirs; these are the staff's reading.
    const refs = await Promise.all(a.files.map(async (f) => ({
      kind: "project" as const, id: (await uploadFile(projectId, f, true)).id, name: f.name, mime: f.type,
    })));
    return (await client.assistant.extract({ threadId: a.threadId, projectId, text: a.text, refs })).messages as UIMessage[];
  }
  const refs = await Promise.all(a.files.map(async (f) => (await uploadAssistantFile(a.threadId, f)).ref));
  return (await client.assistant.intake({ threadId: a.threadId, text: a.text, refs })).messages as UIMessage[];
}
