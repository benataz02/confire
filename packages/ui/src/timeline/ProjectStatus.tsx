import type { CSSProperties } from "react";
import { ObjectStatus, Tag } from "@ui5/webcomponents-react";
import type { ProjectStatus } from "@confire/db";
import { useUiI18n } from "../i18n.ts";
import { PROJECT_STATUS, projectStatusLabel } from "./projectStatus.ts";

// The two ways both apps draw a project's status. Apart from projectStatus.ts because UI5 needs a
// DOM, and the pure tests import that map.

/** A list's status cell. */
export function ProjectStatusCell({ status }: { status: unknown }) {
  const ui = useUiI18n();
  const s = String(status ?? "");
  return <ObjectStatus inverted state={PROJECT_STATUS[s as ProjectStatus]?.state}>{projectStatusLabel(s, (k) => ui.getText(k))}</ObjectStatus>;
}

/** A page title's status tag. */
export function ProjectStatusTag({ status, style }: { status: ProjectStatus; style?: CSSProperties }) {
  const ui = useUiI18n();
  const state = PROJECT_STATUS[status]?.state ?? "None";
  return <Tag design={state === "None" ? "Neutral" : state} style={style}>{projectStatusLabel(status, (k) => ui.getText(k))}</Tag>;
}
