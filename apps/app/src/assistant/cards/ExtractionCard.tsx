import { Text } from "@ui5/webcomponents-react";
import { useI18n } from "../../i18n.ts";
import { ListCard } from "./kit.tsx";
import { sourceText, useScrollToField, type CardCtx, type Source } from "./registry.tsx";

// What a read wrote (tool `extract_values`): each value with the exact text it was read from, a row
// taking the page to its field. The questions it left are the question card's (Task 15).

export type ExtractResult = {
  applied: { key: string; label: string; value: unknown; source: Source }[];
  questions: { key: string; why: string; detail: string; read?: unknown; candidates: unknown[] }[];
  notes: string[];
};

const show = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === "object" ? "…" : String(x))).join(", ") : v === null || v === undefined ? "—" : String(v));

export function ExtractionCard({ r, ctx }: { r: ExtractResult; ctx: CardCtx }) {
  const i18n = useI18n();
  const t = (k: string, ...a: Array<string | number>) => i18n.getText(k, ...a.map(String));
  const scroll = useScrollToField();
  const projectId = ctx.threadProjectId ?? ctx.projectId;
  const files = [...new Set(r.applied.flatMap((a) => ("file" in a.source ? [a.source.file] : [])))];
  return (
    <ListCard title={t("ASSISTANT_READ_FROM", files.join(", ") || t("ASSISTANT_READ_FROM_TEXT"))}
      subtitle={t("ASSISTANT_READ_COUNTS", r.applied.length, r.questions.length)}
      items={r.applied.map((a) => ({
        id: a.key, title: `${a.label}: ${show(a.value)}`, description: sourceText(a.source, t), icon: "ai",
        ...(projectId ? { onOpen: () => scroll(projectId, a.key === "batches" ? "__batches" : a.key, ctx.projectId === projectId) } : {}),
      }))}
      noData={t("ASSISTANT_READ_NOTHING")} moreText={t("ASSISTANT_CARD_MORE")}>
      {r.notes.length ? (
        <ul style={{ margin: "0 1rem 0.75rem", paddingInlineStart: "1rem" }}>
          {r.notes.map((n, i) => <li key={i}><Text>{n}</Text></li>)}
        </ul>
      ) : null}
    </ListCard>
  );
}
