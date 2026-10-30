import type { ReactNode } from "react";
import type { UIMessage } from "@tanstack/ai-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AnalyticalCardHeader, Button, Card, Link, ObjectStatus, Text } from "@ui5/webcomponents-react";
import { useCanOpen } from "@confire/ui/EntityLink.tsx";
import { formatLocale, formatValue } from "@confire/ui/format.ts";
import { useUiI18n } from "@confire/ui/i18n.ts";
import { money } from "@confire/ui/money.ts";
import { ProjectTimeline, type TimelineEvent } from "@confire/ui/timeline/ProjectTimeline.tsx";
import { PROJECT_STATUS, projectStatusLabel } from "@confire/ui/timeline/projectStatus.ts";
import { useI18n } from "../../i18n.ts";
import { orpc, useCurrency } from "../../orpc.ts";
import type { ConfigView } from "../../components/configurator/useConfigProcess.ts";
import { configItems, documentItems, documentStatus, openAllOf, requestItems, type CardLink, type ListCardData } from "./data.ts";
import { ListCard, ObjectCard, type CardItem } from "./kit.tsx";
import { ProposalCard, type Proposal } from "./ProposalCard.tsx";
import { ExtractionCard, type ExtractResult } from "./ExtractionCard.tsx";
import { QuoteCard, type QuoteDraft } from "./QuoteCard.tsx";
import { ChoiceCard, type Ask } from "./ChoiceCard.tsx";

// Tool name → card (plan "The look"). The tool's name picks the card, never the model, and the card
// draws the tool's output, so its figures are the server's. A decision tool's card (steps.ts DECISION)
// is drawn in the chat; every other one is the body of its step, shown when the step is opened. A
// card's actions navigate or scroll the page; only the choice card answers the model, as the user.

export type ToolPart = { name: string; input: unknown; output: unknown; error?: string };

/** What a card may know and do beyond its tool's output: where the panel is, and the chat's few
 *  direct writes (a step the card runs answers messages the chat shows as they are). */
export type CardCtx = {
  /** the configuration whose form is on screen (none on the AI configuration page) */
  projectId: string | null;
  threadId: string;
  /** the thread's configuration, once one was started from it */
  threadProjectId: string | null;
  /** links the chat to it and, in the panel, opens its form (the AI page stays) */
  onStarted(projectId: string): Promise<void>;
  append(messages: UIMessage[]): void;
  setPending(text: string | null): void;
  /** the files of the last drop, by name */
  lastFiles: string[];
  errorText(e: unknown): string;
  /** sends a message as the user typed it (a choice card's pick) */
  send(text: string): void;
  /** the chat is answering or a step runs: nothing new may be sent */
  busy: boolean;
  /** the user's next message after the card's own, once there is one */
  answer?: string;
};
type Ctx = CardCtx;

const MUTED = { color: "var(--sapContent_LabelColor)" } as const;
const DOC_TITLE: Record<string, string> = { Quotations: "NAV_QUOTATIONS", Orders: "NAV_ORDERS", BusinessPartners: "NAV_BP" };

/** The tools that have a card of their own (the switch below), opened from their step. */
export const CARDS: ReadonlySet<string> = new Set([
  "configs_rows", "requests_rows", "entities_rows", "configs_get", "configs_select", "configs_calculate",
  "configs_queryPage", "configs_similar", "configs_models", "configs_create", "home_overview", "read_request",
  "extract_values", "propose_quotation", "timeline_list", "ask_user",
]);

export function renderTool(part: ToolPart, ctx: Ctx): ReactNode {
  return <ToolCard part={part} ctx={ctx} />;
}

/** The busy line while a tool runs: "Looking up configurations…". */
export function progressText(name: string, t: (key: string) => string): string {
  const key = `ASSISTANT_TOOL_${name}_RUNNING`;
  const s = t(key);
  return s === key ? t("ASSISTANT_WORKING") : s;
}

/** The configuration page's field anchor (the one configMessages.ts jumps to): scrolled into view
 *  and focused, after opening the configuration when the panel is elsewhere. */
export function useScrollToField() {
  const navigate = useNavigate({ from: "/$slug" });
  return (projectId: string, key: string, here: boolean) => {
    const go = () => {
      const el = document.querySelector<HTMLElement>(`[data-param="${CSS.escape(key)}"]`) ?? document.getElementById(key);
      el?.scrollIntoView({ block: "center" });
      (el?.querySelector<HTMLElement>(FOCUSABLE) ?? el)?.focus();
    };
    if (here) go();
    else void navigate({ to: "/$slug/configs/$id", params: { id: projectId } }).then(() => setTimeout(go, 300));
  };
}

/** The field's own control inside its anchor. */
const FOCUSABLE = "ui5-input, ui5-select, ui5-combobox, ui5-multi-combobox, ui5-step-input, ui5-checkbox, ui5-switch, ui5-radio-button, ui5-textarea, ui5-segmented-button, input, [tabindex]";

/** The app's texts, falling back to the shared shells' (status names are theirs). */
function useText() {
  const app = useI18n();
  const ui = useUiI18n();
  return (k: string, ...a: Array<string | number>) => {
    const s = app.getText(k, ...a.map(String));
    return s === k ? ui.getText(k, ...a.map(String)) : s;
  };
}

function useLinks() {
  const navigate = useNavigate({ from: "/$slug" });
  return (l: CardLink) => void navigate({ to: `/$slug${l.to}` as "/$slug", search: (l.search ?? {}) as never });
}

const muted = (text: string) => <Text style={MUTED}>{text}</Text>;

function ToolCard({ part, ctx }: { part: ToolPart; ctx: Ctx }) {
  const t = useText();
  const open = useLinks();
  const canOpen = useCanOpen();
  if (part.error) return muted(part.error);
  const input = (part.input ?? {}) as Record<string, any>;
  const out = part.output as any;
  const list = (title: string, d: ListCardData, all?: CardLink | null) => (
    <ListCard title={title} subtitle={d.total > d.items.length ? t("ASSISTANT_CARD_OF", String(d.items.length), String(d.total)) : undefined}
      items={d.items.map(({ link, ...x }): CardItem => ({ ...x, ...(link ? { onOpen: () => open(link) } : {}) }))}
      total={d.total} openAll={all ? () => open(all) : undefined} openAllText={t("ASSISTANT_CARD_OPEN_ALL", String(d.total))}
      noData={t("ASSISTANT_CARD_NONE")} moreText={t("ASSISTANT_CARD_MORE")} />
  );

  switch (part.name) {
    case "configs_rows":
      return list(t("ASSISTANT_CARD_CONFIGS"), configItems(out, t), openAllOf("/configs", input.query ?? { filter: [] }));
    case "requests_rows":
      return list(t("ASSISTANT_CARD_REQUESTS"), requestItems(out, t), openAllOf("/requests", input.query ?? { filter: [] }));
    case "entities_rows": {
      const entity = String(input.entity ?? "");
      const d = documentItems(entity, out, canOpen, t);
      const title = DOC_TITLE[entity] ? t(DOC_TITLE[entity]!) : entity;
      if (d.items.length === 1 && entity !== "BusinessPartners") {
        const r = out.rows[0] as Record<string, unknown>;
        const link = d.items[0]!.link;
        return (
          <ObjectCard title={`${title} ${d.items[0]!.title}`} subtitle={String(r.CardName ?? "")}
            status={{ text: documentStatus(r.DocumentStatus, t), state: d.items[0]!.infoState ?? "None" }}
            onOpen={link ? () => open(link) : undefined}
            facts={[
              { label: t("ASSISTANT_CARD_DATE"), value: <Text>{formatValue(r.DocDate, "date")}</Text> },
              { label: t("ASSISTANT_CARD_TOTAL"), value: <Text>{d.items[0]!.info ?? ""}</Text> },
            ]} />
        );
      }
      return list(title, d, canOpen(`/b1/${entity}`) ? openAllOf(`/b1/${entity}`, input.query ?? { filter: [] }) : null);
    }
    case "configs_get":
    case "configs_select":
      return <ConfigCard view={out as ConfigView} ctx={ctx} />;
    case "configs_calculate":
      return <ChangedCard input={input} view={out as ConfigView} ctx={ctx} />;
    case "configs_queryPage": {
      const rows = (out?.rows ?? []) as unknown[][];
      return list(t("ASSISTANT_CARD_OPTIONS"), {
        items: rows.map((r, i) => ({ id: String(i), title: String(r[0] ?? ""), description: r.slice(1).filter((x) => x !== null && x !== "").join(" · ") })),
        total: rows.length, openAll: null,
      });
    }
    case "configs_similar": {
      const results = (out?.results ?? []) as { score: number; display: Record<string, unknown> }[];
      return list(t("ASSISTANT_CARD_SIMILAR"), {
        items: results.map((r, i) => {
          const [first, ...rest] = Object.values(r.display).filter((x) => x !== null && x !== "").map(String);
          return { id: String(i), title: first ?? "—", description: rest.join(" · "), info: `${Math.round(r.score * 100)} %` };
        }),
        total: results.length, openAll: null,
      });
    }
    case "configs_models": {
      const models = (out ?? []) as { id: string; name: string; description: string | null }[];
      return list(t("ASSISTANT_CARD_MODELS"), { items: models.map((m) => ({ id: m.id, title: m.name, description: m.description ?? undefined })), total: models.length, openAll: null });
    }
    case "configs_create":
      return (
        <Text style={MUTED}>{t("ASSISTANT_TOOL_configs_create")}{" "}
          <Link onClick={() => open({ to: `/configs/${out.id}` })}>{t("ASSISTANT_CARD_OPEN")}</Link>
        </Text>
      );
    case "home_overview":
      return <OverviewCard o={out} />;
    case "read_request":
      return <ProposalCard p={out as Proposal} ctx={ctx} />;
    case "extract_values":
      return <ExtractionCard r={out as ExtractResult} ctx={ctx} />;
    case "ask_user":
      return <ChoiceCard ask={input as Ask} ctx={ctx} />;
    case "propose_quotation":
      return <QuoteCard projectId={String(input.projectId ?? "")} d={out as QuoteDraft} />;
    case "timeline_list":
      return <HistoryCard projectId={String(input.projectId ?? "")} out={out} here={ctx.projectId === input.projectId} />;
    default: {
      const key = `ASSISTANT_TOOL_${part.name}`;
      const s = t(key);
      return muted(s === key ? part.name : s);
    }
  }
}

/** One configuration: what is still missing, the lowest unit price per quantity, the picks. */
function ConfigCard({ view, ctx }: { view: ConfigView; ctx: Ctx }) {
  const t = useText();
  const open = useLinks();
  const currency = useCurrency();
  const p = view.project;
  const lowest = new Map<number, number>();
  for (const r of view.candidates.rows)
    for (const b of r.perBatch) if (!lowest.has(b.batchQty) || b.unitPrice < lowest.get(b.batchQty)!) lowest.set(b.batchQty, b.unitPrice);
  const here = ctx.projectId === p.id;
  const picked = view.selection.picks.length > 0;
  return (
    <ObjectCard title={p.name} subtitle={[p.customer?.cardName, view.model?.name].filter(Boolean).join(" · ") || undefined}
      status={{ text: projectStatusLabel(p.status, t), state: PROJECT_STATUS[p.status].state }}
      onOpen={here ? undefined : () => open({ to: `/configs/${p.id}` })}
      facts={[
        {
          label: t("ASSISTANT_CARD_MISSING"),
          value: view.missing.length
            ? <ObjectStatus state="Critical">{t("ASSISTANT_CARD_MISSING_N", String(view.missing.length))}</ObjectStatus>
            : <Text>{t("ASSISTANT_CARD_MISSING_NONE")}</Text>,
        },
        ...(lowest.size ? [{
          label: t("ASSISTANT_CARD_UNIT_PRICE"),
          value: <Text>{[...lowest].sort((a, b) => a[0] - b[0]).map(([q, u]) => `${q}: ${money(u, currency)}`).join(" · ")}</Text>,
        }] : []),
        ...(picked ? [{ label: t("ASSISTANT_CARD_PICKS"), value: <Text>{money(view.selection.total, currency)}</Text> }] : []),
      ]}
      actions={
        <>
          {here ? null : <Button onClick={() => open({ to: `/configs/${p.id}` })}>{t("ASSISTANT_CARD_OPEN")}</Button>}
          {picked && p.status !== "quoted"
            ? <Button design="Emphasized" onClick={() => open({ to: `/configs/${p.id}/quote` })}>{t("ASSISTANT_CARD_REVIEW")}</Button>
            : null}
        </>
      } />
  );
}

export type Source = { file: string; page: number | null; quote: string } | { chat: string };

/** A source as one line: `RFQ.pdf p.1 · "W 200"`, or the user's own words. */
export function sourceText(s: Source | undefined, t: (k: string, ...a: Array<string | number>) => string): string | undefined {
  if (!s) return undefined;
  if ("chat" in s) return t("ASSISTANT_SOURCE_CHAT", s.chat);
  return s.page === null ? t("ASSISTANT_SOURCE_IMAGE", s.file, s.quote) : t("ASSISTANT_SOURCE_FILE", s.file, String(s.page), s.quote);
}

/** What a write changed, each value with its source; a row takes the page to its field. */
function ChangedCard({ input, view, ctx }: { input: Record<string, any>; view: ConfigView; ctx: Ctx }) {
  const t = useText();
  const qc = useQueryClient();
  const scroll = useScrollToField();
  const id = String(input.id ?? view.project.id);
  // The model's labels and types: the page's own `configs.get` holds them (a write answers no model).
  const def = qc.getQueryData<ConfigView>(orpc.configs.get.queryKey({ input: { id } }))?.model?.definition;
  const param = (k: string) => def?.parameters.find((p) => p.key === k);
  const sources = (input.sources ?? {}) as Record<string, Source>;
  const keys = [...Object.keys(input.set ?? {}), ...Object.keys(input.tables ?? {}), ...(input.batches ? ["batches"] : [])];
  const items: CardItem[] = keys.map((k) => {
    const p = param(k);
    const value = k === "batches" ? (input.batches as number[]).join(", ")
      : input.tables?.[k] ? `${(input.tables[k] as unknown[]).length}`
      : formatValue(view.project.entries[k] ?? input.set?.[k], p?.type === "number" ? "number" : p?.type === "boolean" ? "boolean" : "string",
        view.form.fields[k]?.options?.map((o) => ({ value: o.value as string, label: o.label })));
    const label = k === "batches" ? t("ASSISTANT_CARD_BATCHES") : p?.label ?? def?.tables?.find((x) => x.key === k)?.title ?? k;
    return {
      id: k, title: `${label}: ${value}`, description: sourceText(sources[k], t), icon: sources[k] ? "ai" : undefined,
      onOpen: () => scroll(id, k === "batches" ? "__batches" : k, ctx.projectId === id),
    };
  });
  return <ListCard title={t("ASSISTANT_CARD_CHANGED")} items={items} noData={t("ASSISTANT_CARD_NONE")} moreText={t("ASSISTANT_CARD_MORE")} />;
}

/** The home figures, each opening the list the home tile opens. */
function OverviewCard({ o }: { o: Record<string, number> }) {
  const t = useText();
  const open = useLinks();
  const currency = useCurrency();
  const compact = new Intl.NumberFormat(formatLocale(), { notation: "compact", maximumFractionDigits: 1 });
  const tile = (title: string, value: number | string, link: CardLink | null, state: "None" | "Critical" = "None", scale?: string) => (
    <Card key={title} header={<AnalyticalCardHeader titleText={title} value={String(value)} scale={scale} state={state}
      onClick={link ? () => open(link) : undefined} />} />
  );
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(11rem, 1fr))", gap: "0.5rem" }} aria-label={t("ASSISTANT_CARD_MONTH")}>
      {tile(t("HOME_MY_DRAFTS"), o.myDrafts ?? 0, { to: "/configs", search: { status: "draft", mine: "yes" } })}
      {tile(t("HOME_MY_IN_REVIEW"), o.myInReview ?? 0, { to: "/requests", search: { status: "in_review", mine: "yes" } })}
      {tile(t("HOME_MY_QUOTED"), compact.format(o.myQuotedValue ?? 0), null, "None", currency)}
      {tile(t("ASSISTANT_CARD_NEW_REQUESTS"), o.newRequests ?? 0, { to: "/requests", search: { status: "submitted" } }, (o.newRequests ?? 0) > 0 ? "Critical" : "None")}
    </div>
  );
}

/** A configuration's last few events, read-only. */
function HistoryCard({ projectId, out, here }: { projectId: string; out: { events: TimelineEvent[]; labels: Record<string, string> }; here: boolean }) {
  const i18n = useI18n();
  const open = useLinks();
  const currency = useCurrency();
  return (
    <Card>
      <ProjectTimeline events={(out?.events ?? []).slice(-5)} labels={out?.labels ?? {}} side="internal" currency={currency}
        canComment={false} onComment={async () => undefined} />
      {here ? null : (
        <div style={{ padding: "0.5rem 1rem 0.75rem" }}>
          <Link onClick={() => open({ to: `/configs/${projectId}` })}>{i18n.getText("ASSISTANT_CARD_OPEN_CONFIG")}</Link>
        </div>
      )}
    </Card>
  );
}
