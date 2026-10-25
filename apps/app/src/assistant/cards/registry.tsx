import type { ReactNode } from "react";
import { Text } from "@ui5/webcomponents-react";

// Tool name → card (assistant spec, "The look"). The tool's name picks the card, never the model, and
// the card draws the tool's output. Task 13 fills this in; until then a tool shows its name.

export type ToolPart = { name: string; input: unknown; output: unknown; error?: string };

const MUTED = { color: "var(--sapContent_LabelColor)" } as const;

export function renderTool(part: ToolPart, _ctx: { projectId: string | null }): ReactNode {
  return <Text style={MUTED}>{part.error ?? part.name}</Text>;
}

export function progressText(_name: string, t: (key: string) => string): string {
  return t("ASSISTANT_WORKING");
}
