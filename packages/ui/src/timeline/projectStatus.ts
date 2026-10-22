import type { ProjectStatus } from "@confire/db";
import type { Option } from "../types.ts";

/** A project's status as both apps show it (spec §7: the client-facing words). The value state is
 *  whose move it is: Information while the supplier works, Critical when the client must act. */
export const PROJECT_STATUS: Record<ProjectStatus, { text: string; state: "None" | "Information" | "Positive" | "Critical" | "Negative" }> = {
  draft: { text: "Draft", state: "None" },
  submitted: { text: "Submitted", state: "Information" },
  in_review: { text: "In review", state: "Information" },
  returned: { text: "Changes requested", state: "Critical" },
  declined: { text: "Declined", state: "Negative" },
  quoted: { text: "Quoted", state: "Positive" },
};

/** i18n keys for `text`. The map itself stays English so a test can keep asserting those ids. */
export const PROJECT_STATUS_KEY: Record<ProjectStatus, string> = {
  draft: "UI_STATUS_DRAFT",
  submitted: "UI_STATUS_SUBMITTED",
  in_review: "UI_STATUS_IN_REVIEW",
  returned: "UI_STATUS_CHANGES",
  declined: "UI_STATUS_DECLINED",
  quoted: "UI_STATUS_QUOTED",
};

/** The label a reader sees. Without `t`, the English text on PROJECT_STATUS. */
export function projectStatusLabel(
  status: ProjectStatus,
  t?: (key: string, ...params: Array<string | number>) => string,
): string {
  return t ? t(PROJECT_STATUS_KEY[status]) : PROJECT_STATUS[status].text;
}

export const PROJECT_STATUS_OPTIONS: Option[] =
  Object.entries(PROJECT_STATUS).map(([value, s]) => ({ value, label: s.text }));
