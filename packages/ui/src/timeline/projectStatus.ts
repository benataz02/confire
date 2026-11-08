import type { ProjectStatus } from "@confire/db";
import type { Option, ValueState } from "../types.ts";

/** A project's status as every list and page of both apps shows it — the one definition (spec §7).
 *  `key` is the `@confire/ui` text; the state is whose move it is: Information while the supplier
 *  works, Critical when the client must act. Drawn by `ProjectStatus.tsx`. */
export const PROJECT_STATUS: Record<ProjectStatus, { key: string; state: ValueState }> = {
  draft: { key: "UI_STATUS_DRAFT", state: "None" },
  submitted: { key: "UI_STATUS_SUBMITTED", state: "Information" },
  in_review: { key: "UI_STATUS_IN_REVIEW", state: "Information" },
  returned: { key: "UI_STATUS_CHANGES", state: "Critical" },
  declined: { key: "UI_STATUS_DECLINED", state: "Negative" },
  quoted: { key: "UI_STATUS_QUOTED", state: "Positive" },
  ordered: { key: "UI_STATUS_ORDERED", state: "Positive" },
  // UI_STATUS_DELIVERED is a B1 document's (documentStatus.ts), in other words.
  delivered: { key: "UI_STATUS_PROJECT_DELIVERED", state: "Positive" },
  invoiced: { key: "UI_STATUS_INVOICED", state: "Positive" },
  claim: { key: "UI_STATUS_CLAIM", state: "Information" },
};

/** `t` reads the `@confire/ui` bundle. */
type T = (key: string) => string;

/** The label a reader sees. A status this map does not know reads as stored — a code, not a sentence. */
export function projectStatusLabel(status: string, t: T): string {
  const s = PROJECT_STATUS[status as ProjectStatus];
  return s ? t(s.key) : status;
}

/** A list's status filter: every status, whichever list. */
export const projectStatusOptions = (t: T): Option[] =>
  Object.entries(PROJECT_STATUS).map(([value, s]) => ({ value, label: t(s.key) }));

/** Staff may edit it, and quote it (the server's `canWrite`, staff side): an internal configuration
 *  while it is a draft, a client's request while it is in review. */
export const staffWritable = (p: { status: string; portalCardCode: string | null }): boolean =>
  p.portalCardCode === null ? p.status === "draft" : p.status === "in_review";
