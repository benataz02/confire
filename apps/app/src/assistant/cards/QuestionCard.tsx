import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, Input, Link, type InputDomRef, List, ListItemStandard, Option, Select, Text, ToggleButton } from "@ui5/webcomponents-react";
import { CflField } from "@confire/ui/cfl/CflField.tsx";
import { cfl } from "@confire/ui/cfl/cfl-configs.ts";
import { useI18n } from "../../i18n.ts";
import { client, orpc } from "../../orpc.ts";
import type { ConfigView } from "../../components/configurator/useConfigProcess.ts";
import { CUSTOMER, nextQuestion, type Q } from "../questions.ts";
import { useScrollToField } from "./registry.tsx";

// The open questions, one at a time (assistant spec §4.1 step 4): each answered by a chip, with no
// model call — the chip writes `configs.calculate` directly, without a source (a person picked it, so
// the page shows no ✦), and the answer patches the page's own view, which brings the next question.
// Skip sends one to the back. A rule that rules an option out says so beside it: that is how the rules
// teach. Unsure, the user sees what similar past quotes used for the field and takes it in one click.

const CHIPS_MAX = 8;
const ROW = { display: "flex", flexDirection: "column", gap: "0.375rem", padding: "0.5rem 1rem", borderTop: "1px solid var(--sapGroup_TitleBorderColor)" } as const;
const CHIPS = { display: "flex", flexWrap: "wrap", gap: "0.375rem" } as const;
const MUTED = { color: "var(--sapContent_LabelColor)", fontSize: "var(--sapFontSmallSize)" } as const;

type Write = { set?: Record<string, unknown>; batches?: number[]; customer?: { cardCode: string; cardName: string } };

const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === null || v === undefined ? "—" : String(v));
const filled = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length);
const LINKS = { display: "flex", flexWrap: "wrap", gap: "1rem", padding: "0.25rem 1rem 0.75rem" } as const;

export function QuestionCard({ projectId, view, questions, here, onKeep, onAnswer, skipped, onSkip }: {
  projectId: string; view: ConfigView; questions: Q[]; here: boolean; onKeep: (key: string) => void;
  /** the keys skipped, in order (the chat's: it hands the answers over once only these are left) */
  skipped: readonly string[];
  onSkip: (key: string) => void;
  /** an answer written, as the user would say it ("Width: 200") */
  onAnswer: (said: string) => void;
}) {
  const i18n = useI18n();
  const t = (k: string, ...a: Array<string | number>) => i18n.getText(k, ...a.map(String));
  const qc = useQueryClient();
  const scroll = useScrollToField();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [other, setOther] = useState<string | null>(null);
  const [unsure, setUnsure] = useState<string | null>(null);
  // Enter answers and the next question's field takes the cursor, so a run of values is typed straight
  // through (the row is keyed by question, so the answered field is gone). Not on blur: a click elsewhere keeps its focus.
  const input = useRef<InputDomRef>(null);
  const entered = useRef(false);
  // "2 of 5": every question this card has shown counts, so the count holds as answers close them.
  const seen = useRef(new Set<string>());
  for (const x of questions) seen.current.add(x.key);
  const lookups = useQuery({ ...orpc.configs.lookups.queryOptions({ input: { modelId: view.project.modelId } }), staleTime: 5 * 60_000 });
  const params = new Map((view.model?.definition.parameters ?? []).map((p) => [p.key, p]));

  const write = async (key: string, w: Write, said: string) => {
    setErrors((e) => ({ ...e, [key]: "" }));
    try {
      const answer = await client.configs.calculate({ id: projectId, ...w } as never);
      qc.setQueryData(orpc.configs.get.queryKey({ input: { id: projectId } }), (prev: ConfigView | undefined) => (prev ? { ...prev, ...answer } : prev));
      setOther(null);
      onAnswer(said);
    } catch (e) {
      setErrors((x) => ({ ...x, [key]: e instanceof Error ? e.message : String(e) }));
    }
  };
  const setValue = (q: Q, v: unknown) => write(q.key, q.key === "batches" ? { batches: v as number[] } : { set: { [q.key]: v } },
    `${q.label}: ${q.options.find((o) => o.value === v)?.label ?? show(v)}`);
  /** Why it is asked, in the reader's words. */
  const whyText = (q: Q) => {
    switch (q.why) {
      case "missing": return t("ASSISTANT_WHY_missing");
      case "differs": return t("ASSISTANT_WHY_differs", show(q.read), show(q.current));
      case "out_of_range": return t("ASSISTANT_WHY_out_of_range", show(q.read), q.detail ?? "");
      case "not_an_option": case "unavailable": return t(`ASSISTANT_WHY_${q.why}`, show(q.read));
      default: return t(`ASSISTANT_WHY_${q.why}`, q.detail ?? "");
    }
  };
  const typed = (q: Q, raw: string) => {
    const p = params.get(q.key);
    const v = p?.type === "number" ? Number(raw) : p?.type === "boolean" ? raw === "true" : raw;
    if (raw.trim() !== "" && !(typeof v === "number" && Number.isNaN(v))) void setValue(q, v);
  };

  const q = nextQuestion(questions, skipped);
  useEffect(() => {
    if (entered.current) void input.current?.focus();
    entered.current = false;
  }, [q?.key]);
  if (!q) return null;
  const total = seen.current.size;
  const label = q.kind === "customer" ? t("ASSISTANT_CUSTOMER") : q.label;
  const current = q.key === "batches" ? view.project.batches : (view.project.entries as Record<string, unknown>)[q.key];
  const ruled = [...new Set(q.options.flatMap((o) => (o.unavailable ? [o.unavailable] : [])))];
  const p = params.get(q.key);
  const ref = p?.domain?.kind === "options" ? p.domain.ref : undefined;
  // Past quotes can only say what they recorded: a parameter the model's history maps.
  const askSimilar = !!view.model?.definition.history?.mappings.some((m) => !m.table && m.param === q.key);
  return (
    <Card header={<CardHeader titleText={t("ASSISTANT_QUESTION_OF", total - questions.length + 1, total)} />}>
      <div key={q.key} style={ROW}>
        <Link onClick={() => scroll(projectId, q.key === CUSTOMER ? "cfg-customer" : q.key === "batches" ? "__batches" : q.key, here)}>{label}</Link>
        <Text style={MUTED}>{whyText(q)}</Text>
        {q.why === "differs" ? (
          <div style={CHIPS}>
            <ToggleButton onClick={() => onKeep(q.key)}>{t("ASSISTANT_KEEP", show(q.current))}</ToggleButton>
            <ToggleButton onClick={() => void setValue(q, q.read)}>{t("ASSISTANT_USE", show(q.read))}</ToggleButton>
          </div>
        ) : q.kind === "customer" ? (
          <CflField config={{ dialogConfig: cfl.customers() }} value={view.project.customer?.cardCode ?? null}
            accessibleName={label}
            onValueChange={() => undefined}
            onRowSelect={(row) => void write(q.key, { customer: { cardCode: String(row.CardCode ?? ""), cardName: String(row.CardName ?? "") } },
              `${label}: ${String(row.CardName ?? "")} (${String(row.CardCode ?? "")})`)} />
        ) : q.kind === "query" && ref && ref.source !== "manual" ? (
          <CflField config={{ dialogConfig: cfl.masterdataQuery({ modelId: view.project.modelId }, ref, lookups.data?.tables[ref.table], { title: label }) }}
            value={current ?? null} commitOnly accessibleName={label}
            onValueChange={(v) => { if (v !== null && v !== "") void setValue(q, v); }} />
        ) : q.kind === "options" && q.options.length > CHIPS_MAX ? (
          <Select accessibleName={label} onChange={(e) => {
            const o = q.options[Number(e.detail.selectedOption.dataset.i)];
            if (o) void setValue(q, o.value);
          }}>
            <Option data-i="-1">{t("ASSISTANT_OTHER")}</Option>
            {q.options.map((o, i) => o.unavailable ? null : <Option key={i} data-i={String(i)} selected={o.value === current}>{o.label}</Option>)}
          </Select>
        ) : q.kind === "options" ? (
          <div style={CHIPS}>
            {q.options.map((o, i) => (
              <ToggleButton key={i} pressed={o.value === current} disabled={!!o.unavailable} tooltip={o.unavailable}
                onClick={() => void setValue(q, o.value)}>{o.label}</ToggleButton>
            ))}
          </div>
        ) : null}
        {ruled.map((r) => <Text key={r} style={MUTED}>{t("ASSISTANT_RULED_OUT", r)}</Text>)}
        {q.kind === "free" && q.why !== "differs" || other === q.key ? (
          <Input ref={input} type={p?.type === "number" ? "Number" : "Text"} accessibleName={label}
            onKeyDown={(e) => { if (e.key === "Enter") entered.current = true; }}
            valueState={errors[q.key] ? "Negative" : "None"} valueStateMessage={<div>{errors[q.key]}</div>}
            onChange={(e) => typed(q, e.target.value)} />
        ) : q.kind === "options" || q.why === "differs" && q.key !== "batches" ? (
          <Link onClick={() => setOther(q.key)}>{t("ASSISTANT_OTHER")}</Link>
        ) : null}
        {errors[q.key] && !(q.kind === "free" || other === q.key) ? <Text style={{ color: "var(--sapNegativeTextColor)" }}>{errors[q.key]}</Text> : null}
      </div>
      {unsure === q.key && askSimilar ? (
        <SimilarValues projectId={projectId} view={view} q={q} label={(v) => q.options.find((o) => o.value === v)?.label ?? show(v)}
          onUse={(v) => { setUnsure(null); void setValue(q, v); }} />
      ) : null}
      <div style={LINKS}>
        {askSimilar && unsure !== q.key ? <Link onClick={() => setUnsure(q.key)}>{t("ASSISTANT_NOT_SURE")}</Link> : null}
        {questions.length > 1 ? <Link onClick={() => { setUnsure(null); onSkip(q.key); }}>{t("ASSISTANT_SKIP")}</Link> : null}
      </div>
    </Card>
  );
}

/** What the most similar past quotes used for this field (configs.similar over what is filled so
 *  far), each taken with one click.
 *  ponytail: parameters only — the items grid's rows are left out of the match; add SimilarConfigs'
 *  `items` probes if grid-heavy models need it. */
function SimilarValues({ projectId, view, q, label, onUse }: {
  projectId: string; view: ConfigView; q: Q; label: (v: unknown) => string; onUse: (v: unknown) => void;
}) {
  const i18n = useI18n();
  const t = (k: string, ...a: Array<string | number>) => i18n.getText(k, ...a.map(String));
  const entries = view.project.entries as Record<string, unknown>;
  const mapped = Object.fromEntries((view.model?.definition.history?.mappings ?? [])
    .filter((m) => !m.table && filled(entries[m.param])).map((m) => [m.param, entries[m.param]]));
  const similar = useQuery(orpc.configs.similar.queryOptions({ input: { id: projectId, entries: mapped as Record<string, never> } }));
  const rows = (similar.data?.results ?? []).slice(0, 3);
  return (
    <List separators="Inner" header={<Text style={{ ...MUTED, padding: "0.5rem 1rem 0.25rem" }}>{t("ASSISTANT_SIMILAR")}</Text>}
      accessibleName={t("ASSISTANT_SIMILAR")}
      noDataText={similar.isPending ? t("ASSISTANT_WORKING") : t("ASSISTANT_CARD_NONE")}
      onItemClick={(e) => {
        const r = rows[Number((e.detail.item as HTMLElement).dataset.i)];
        if (r && filled(r.values[q.key])) onUse(r.values[q.key]);
      }}>
      {rows.map((r, i) => {
        const [head, ...rest] = Object.values(r.display).filter((x) => x !== null && x !== "").map(String);
        const v = r.values[q.key];
        return (
          <ListItemStandard key={i} data-i={String(i)} type={filled(v) ? "Active" : "Inactive"} wrappingType="Normal"
            description={[...rest, `${Math.round(r.score * 100)} %`].join(" · ")}
            additionalText={filled(v) ? t("ASSISTANT_SIMILAR_USE", label(v)) : t("ASSISTANT_SIMILAR_NONE")}
            additionalTextState={filled(v) ? "Information" : "None"}>
            {head ?? "—"}
          </ListItemStandard>
        );
      })}
    </List>
  );
}
