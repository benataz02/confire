import { useState } from "react";
import { Button, Card, CardHeader, List, ListItemStandard, Text } from "@ui5/webcomponents-react";
import { useI18n } from "../../i18n.ts";
import type { CardCtx } from "./registry.tsx";

// The model's question (tool `ask_user`): its options as a list, each one click away. A pick is the
// user's next message, so the model writes it with the user's words as its source; typing in the
// composer answers it too. Once answered, the pick stays ticked and the list goes inactive.
// A brief (`more`, or a question with several answers) is one card of lists and one Send: its
// answer is one message, a line per question.

type Question = { question: string; options: { label: string; description?: string }[]; multiple?: boolean };
export type Ask = Question & { more?: Question[] };

const HINT = { display: "block", padding: "0.5rem 1rem 0.75rem", color: "var(--sapContent_LabelColor)", fontSize: "var(--sapFontSmallSize)" } as const;

export function ChoiceCard({ ask, ctx }: { ask: Ask; ctx: CardCtx }) {
  const i18n = useI18n();
  const open = ctx.answer === undefined && !ctx.busy;
  const options = ask.options ?? [];
  if (ask.more?.length || ask.multiple) return <BriefCard questions={[ask, ...(ask.more ?? [])]} ctx={ctx} open={open} />;
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

/** The answer's line for a question: its text, then the picks ("Which period? This year"). */
const lineOf = (q: Question, picks: string[]) => `${q.question} ${picks.length ? picks.join(", ") : "—"}`;

function BriefCard({ questions, ctx, open }: { questions: Question[]; ctx: CardCtx; open: boolean }) {
  const i18n = useI18n();
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []));
  // Answered: the ticks are read back off the message, so a reload shows them too.
  const lines = ctx.answer?.split("\n") ?? null;
  const ticked = (qi: number, label: string) => lines
    ? !!lines.find((l) => l.startsWith(questions[qi]!.question))?.includes(label)
    : picked[qi]!.includes(label);
  const pick = (qi: number, label: string) => setPicked((all) => all.map((p, i) => {
    if (i !== qi) return p;
    if (!questions[qi]!.multiple) return p[0] === label ? [] : [label];
    return p.includes(label) ? p.filter((x) => x !== label) : [...p, label];
  }));
  return (
    <Card>
      {questions.map((q, qi) => (
        <List key={qi} headerText={q.question} separators="Inner" accessibleName={q.question}
          onItemClick={(e) => { if (open) pick(qi, (e.detail.item as HTMLElement).dataset.label ?? ""); }}>
          {(q.options ?? []).map((o) => (
            <ListItemStandard key={o.label} data-label={o.label} description={o.description} wrappingType="Normal"
              type={open ? "Active" : "Inactive"} icon={ticked(qi, o.label) ? "accept" : q.multiple ? "border" : undefined}>
              {o.label}
            </ListItemStandard>
          ))}
        </List>
      ))}
      {ctx.answer === undefined ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", paddingInlineEnd: "1rem" }}>
          <Text style={HINT}>{i18n.getText("ASSISTANT_CHOICE_TYPE")}</Text>
          <Button design="Emphasized" disabled={!open || picked.every((p) => !p.length)}
            onClick={() => ctx.send(questions.map((q, i) => lineOf(q, picked[i]!)).join("\n"))}>
            {i18n.getText("ASSISTANT_SEND")}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
