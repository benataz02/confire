import { ORPCError } from "@orpc/server";
import { agentPost } from "@confire/b1";
import { agentTarget, viaB1 } from "./b1.ts";
import { PRINTABLE } from "./entity-profiles.ts";

// PDF rendering is the agent's SAP B1 API Gateway hop, not a Service Layer read — so it goes
// through agentPost on a route of its own rather than a transport method. entities.print is the
// one caller; the PRINTABLE allowlist is the fence.

export type PrintedDocument = { pdf: string; fileName: string };

export async function printDocument(tenantId: string, entity: string, docEntry: number): Promise<PrintedDocument> {
  if (!PRINTABLE.has(entity)) throw new ORPCError("FORBIDDEN", { message: `${entity} cannot be printed` });
  const target = await agentTarget(tenantId);
  return viaB1(async () => (await agentPost(target, "/print", { entity, docEntry })) as PrintedDocument);
}
