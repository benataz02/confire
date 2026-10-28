import { Card, CardHeader, List, ListItemStandard, Text } from "@ui5/webcomponents-react";
import { useI18n } from "../../i18n.ts";
import type { CardCtx } from "./registry.tsx";

// The model's question (tool `ask_user`): its options as a list, each one click away. A pick is the
// user's next message, so the model writes it with the user's words as its source; typing in the
// composer answers it too. Once answered, the pick stays ticked and the list goes inactive.

export type Ask = { question: string; options: { label: string; description?: string }[] };

const HINT = { display: "block", padding: "0.5rem 1rem 0.75rem", color: "var(--sapContent_LabelColor)", fontSize: "var(--sapFontSmallSize)" } as const;

export function ChoiceCard({ ask, ctx }: { ask: Ask; ctx: CardCtx }) {
  const i18n = useI18n();
  const open = ctx.answer === undefined && !ctx.busy;
  const options = ask.options ?? [];
  return (
    <Card header={<CardHeader titleText={ask.question} />}>
      <List separators="Inner" accessibleName={ask.question}
        onItemClick={(e) => { if (open) ctx.send((e.detail.item as HTMLElement).dataset.label ?? ""); }}>
        {options.map((o) => (
          <ListItemStandard key={o.label} data-label={o.label} description={o.description} wrappingType="Normal"
            type={open ? "Active" : "Inactive"} icon={ctx.answer === o.label ? "accept" : undefined}>
            {o.label}
          </ListItemStandard>
        ))}
      </List>
      {ctx.answer === undefined ? <Text style={HINT}>{i18n.getText("ASSISTANT_CHOICE_TYPE")}</Text> : null}
    </Card>
  );
}
