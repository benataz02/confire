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

export const PROJECT_STATUS_OPTIONS: Option[] =
  Object.entries(PROJECT_STATUS).map(([value, s]) => ({ value, label: s.text }));
