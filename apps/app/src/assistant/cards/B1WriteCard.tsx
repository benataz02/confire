import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button, MessageStrip, Text } from "@ui5/webcomponents-react";
import { useCanOpen, useEntityNav } from "@confire/ui/EntityLink.tsx";
import { useI18n } from "../../i18n.ts";
import { orpc } from "../../orpc.ts";
import { ObjectCard } from "./kit.tsx";
import type { CardCtx } from "./registry.tsx";

// A SAP write (tools `b1_write`, `b1_copy`; b1-tools spec §5.6). A proposal shows what it will write,
// before → after, with Post and Discard: Post is the user's click (`b1.post`, which no tool reaches),
// and either outcome goes to the chat as the user's next message, so the model knows. A written answer
// (auto mode, or after Post) shows the record and opens it.

type Change = { before: unknown; after: unknown };
export type B1Proposal = {
  op: "create" | "update" | "copy"; entity: string; key?: unknown; etag?: string;
  payload: Record<string, unknown>; changes?: Record<string, Change>; title?: string;
};
export type B1Written = { written: { entity: string; key: unknown; docNum?: string | number }; link: string | null };
export type B1WriteOut = { proposal: B1Proposal } | B1Written;

/** Fields that only link a copied line to its source: B1's business, not the reader's. */
const LINK_FIELDS = new Set(["BaseType", "BaseEntry", "BaseLine"]);
/** Refusals a retry cannot fix. */
const FINAL = new Set(["CONFLICT", "BAD_REQUEST", "FORBIDDEN", "NOT_FOUND"]);
const MUTED = { color: "var(--sapContent_LabelColor)" } as const;
const ROW = { display: "grid", gridTemplateColumns: "minmax(6rem, max-content) 1fr", gap: "0.25rem 1rem", padding: "0 1rem 0.75rem", alignItems: "baseline" } as const;

const scalar = (v: unknown): string => (v === null || v === undefined || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
const line = (l: unknown): string => (l && typeof l === "object"
  ? Object.entries(l as Record<string, unknown>).filter(([k]) => !LINK_FIELDS.has(k)).map(([k, v]) => `${k}: ${scalar(v)}`).join(" · ")
  : scalar(l));

/** One change as text: `old → new`, a collection one line each. */
function ChangeValue({ c }: { c: Change }) {
  if (Array.isArray(c.after)) {
    const before = Array.isArray(c.before) ? c.before : [];
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.125rem" }}>
        {c.after.map((l, i) => (
          <Text key={i}>{before[i] ? <><span style={MUTED}>{line(before[i])}</span>{" → "}</> : null}{line(l)}</Text>
        ))}
      </div>
    );
  }
  return <Text>{c.before !== null && c.before !== undefined ? <><span style={MUTED}>{scalar(c.before)}</span>{" → "}</> : null}{scalar(c.after)}</Text>;
}

export function B1WriteCard({ out, ctx }: { out: B1WriteOut; ctx: CardCtx }) {
  const i18n = useI18n();
  const t = (k: string, ...a: string[]) => i18n.getText(k, ...a);
  const go = useEntityNav();
  const canOpen = useCanOpen();
  const posting = useMutation(orpc.b1.post.mutationOptions());
  const [posted, setPosted] = useState<B1Written | null>(null);
  const [error, setError] = useState<{ text: string; final: boolean } | null>(null);

  const done = "written" in out ? out : posted;
  if (done) {
    const { entity, key, docNum } = done.written;
    const route = `/b1/${entity}`;
    const open = key !== null && key !== undefined && canOpen(route) ? () => go(route, key) : undefined;
    return (
      <ObjectCard title={t("ASSISTANT_B1_WRITTEN", entity, scalar(docNum ?? key))} onOpen={open}
        actions={open ? <Button onClick={open}>{t("ASSISTANT_CARD_OPEN")}</Button> : undefined} />
    );
  }

  const p = (out as { proposal: B1Proposal }).proposal;
  const changes = Object.entries(p.changes ?? {});
  // One click in flight; a refusal says why, and a final one (the record changed since) offers no retry.
  const post = () => {
    setError(null);
    posting.mutate({ proposal: p as never }, {
      onSuccess: (r) => {
        const w = r as unknown as B1Written;
        setPosted(w);
        ctx.send(t("ASSISTANT_B1_POSTED", w.written.entity, scalar(w.written.docNum ?? w.written.key)));
      },
      // The record changed, or the write is refused: asking again is the way on. SAP out of reach is
      // worth a retry.
      onError: (e) => setError({ text: ctx.errorText(e), final: FINAL.has((e as { code?: string }).code ?? "") }),
    });
  };
  const open = ctx.answer === undefined && !error?.final;
  return (
    <ObjectCard title={p.title ?? p.entity} subtitle={t("ASSISTANT_B1_PROPOSAL")}
      actions={open ? (
        <>
          <Button design="Emphasized" disabled={ctx.busy || posting.isPending} onClick={post}>{t("ASSISTANT_B1_POST")}</Button>
          <Button disabled={ctx.busy || posting.isPending} onClick={() => ctx.send(t("ASSISTANT_B1_DISCARDED"))}>{t("ASSISTANT_B1_DISCARD")}</Button>
        </>
      ) : ctx.answer !== undefined ? <Text style={MUTED}>{ctx.answer}</Text> : undefined}>
      {changes.length ? (
        <div style={ROW}>
          {changes.flatMap(([k, c]) => [<Text key={`${k}l`} style={MUTED}>{k}</Text>, <ChangeValue key={`${k}v`} c={c} />])}
        </div>
      ) : null}
      {error ? <MessageStrip design="Negative" hideCloseButton style={{ margin: "0 1rem 0.75rem", width: "auto" }}>{error.text}</MessageStrip> : null}
    </ObjectCard>
  );
}
