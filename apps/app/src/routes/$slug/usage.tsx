import { useMemo, useState, type CSSProperties, type ComponentProps } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { t, title } from "../../head.ts";
import { useQuery } from "@tanstack/react-query";
import {
  AnalyticalCardHeader, BusyIndicator, Card, CardHeader, FlexBox, IllustratedMessage, MessageStrip, NumericSideIndicator, Text, Title,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import { ColumnChart, DonutChart } from "@ui5/webcomponents-react-charts";
import { Grid, type GridState } from "@confire/ui/list-report/Grid.tsx";
import { money } from "@confire/ui/money.ts";
import { formatLocale } from "@confire/ui/format.ts";
import type { ListColumn, Row } from "@confire/ui/types.ts";
import { orpc } from "../../orpc.ts";
import { useI18n } from "../../i18n.ts";
import { sortRows } from "../../reports/widgets.ts";

// AI usage (admin): what the assistant cost this month, by day, kind and person, against the
// monthly limit. Drawn as a report is — KPI cards, charts in cards, the people in a Grid — over
// `assistant.usageReport`, which reads `ai_usage` (assistant/usage.ts). Costs are USD: the meter's.

export const Route = createFileRoute("/$slug/usage")({ head: () => title(t("NAV_AI_USAGE")), component: Usage });

const CHART_HEIGHT = "16rem";
const grid = (min: string): CSSProperties => ({ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${min}, 1fr))`, gap: "1rem" });
const PAGE: CSSProperties = { padding: "1rem 1.5rem 2rem", fontFamily: "var(--sapFontFamily)" };
const CHART = { noAnimation: true, chartConfig: { resizeDebounce: 0 }, style: { height: CHART_HEIGHT } };
const KIND_KEY: Record<string, string> = { chat: "USAGE_KIND_CHAT", intake: "USAGE_KIND_INTAKE", extract: "USAGE_KIND_EXTRACT" };
const usd = (v: number) => money(v, "USD");

/** A KPI card. The side indicators are the card's content, not the header's children: the header lays
 *  them beside the value in a row that never wraps, so a narrow card squeezed them until titles wrapped
 *  word by word and values broke mid-word ("21,70 U|S$") — and that row takes no inline style. Here
 *  they sit under the value, each on one line, alike in every card. The grid host stretches the card's
 *  shadow root (its height:100% never resolves against a stretched host), so a row's cards share a height. */
function Kpi({ side, ...header }: ComponentProps<typeof AnalyticalCardHeader> & { side: [string, string][] }) {
  return (
    <Card style={{ display: "grid" }} accessibleName={header.titleText} header={<AnalyticalCardHeader {...header} />}>
      <FlexBox wrap="Wrap" style={{ gap: "0.5rem 1rem", padding: "0 1rem 1rem", marginTop: "-0.5rem" }}>
        {side.map(([title, n]) => <NumericSideIndicator key={title} titleText={title} number={n} style={{ alignItems: "flex-start", flexShrink: 0 }} />)}
      </FlexBox>
    </Card>
  );
}

function Usage() {
  const i18n = useI18n();
  const t = (k: string, ...a: string[]) => i18n.getText(k, ...a);
  const q = useQuery(orpc.assistant.usageReport.queryOptions());
  const locale = formatLocale();
  const num = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const monthName = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });

  const columns = useMemo<ListColumn[]>(() => [
    { key: "name", label: i18n.getText("USAGE_COL_USER") },
    { key: "calls", label: i18n.getText("USAGE_CALLS"), type: "number", width: 110 },
    { key: "chats", label: i18n.getText("USAGE_CHATS"), type: "number", width: 110 },
    { key: "assisted", label: i18n.getText("USAGE_ASSISTED"), type: "number", width: 150 },
    { key: "input", label: i18n.getText("USAGE_COL_INPUT"), type: "number", width: 130 },
    { key: "output", label: i18n.getText("USAGE_COL_OUTPUT"), type: "number", width: 130 },
    { key: "cacheRead", label: i18n.getText("USAGE_COL_CACHE_READ"), type: "number", width: 130, hidden: true },
    { key: "cacheWrite", label: i18n.getText("USAGE_COL_CACHE_WRITE"), type: "number", width: 130, hidden: true },
    { key: "cost", label: i18n.getText("USAGE_COST"), type: "number", width: 120 },
  ], [i18n]);
  const [state, setState] = useState<GridState>({
    columns: columns.filter((c) => !c.hidden).map((c) => c.key), sortBy: [{ field: "cost", direction: "desc" }], groupBy: [], columnWidths: {},
  });
  // A member who left keeps their rows (the meter has no foreign keys): shown by id.
  const rows = useMemo(() => sortRows((q.data?.users ?? []).map((u) => ({ ...u, name: u.name ?? u.userId })) as Row[], state.sortBy),
    [q.data, state.sortBy]);
  const cellTemplates = useMemo(() => ({ cost: (r: Row) => <span>{usd(Number(r.cost))}</span> }), []);

  const u = q.data;
  if (q.error) return <div style={PAGE}><MessageStrip design="Negative" hideCloseButton>{q.error.message}</MessageStrip></div>;
  if (!u) return <BusyIndicator active style={{ width: "100%", marginTop: "3rem" }} />;

  const { totals } = u;
  const share = u.limit > 0 ? totals.cost / u.limit : 0;
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
  const kinds = u.kinds.map((k) => ({ ...k, label: KIND_KEY[k.kind] ? t(KIND_KEY[k.kind]!) : k.kind }));
  const empty = <IllustratedMessage name="NoData" design="Spot" titleText={t("USAGE_EMPTY")} style={{ height: CHART_HEIGHT }} />;

  return (
    <FlexBox direction="Column" gap="1rem" style={PAGE}>
      <FlexBox direction="Column" gap="0.25rem">
        <Title level="H3">{t("USAGE_TITLE")}</Title>
        <Text style={{ color: "var(--sapContent_LabelColor)" }}>{t("USAGE_SUBTITLE", u.model)}</Text>
      </FlexBox>

      <div style={grid("16rem")}>
        <Kpi titleText={t("USAGE_COST")} subtitleText={t("USAGE_THIS_MONTH")} value={usd(totals.cost)}
          state={share >= 1 ? "Error" : share >= 0.8 ? "Critical" : "Good"}
          side={[[t("USAGE_LIMIT"), usd(u.limit)], [t("USAGE_LAST_MONTH"), usd(u.months.at(-2)?.cost ?? 0)]]} />
        <Kpi titleText={t("USAGE_CALLS")} subtitleText={t("USAGE_THIS_MONTH")} value={num.format(totals.calls)}
          side={[[t("USAGE_CHATS"), num.format(totals.chats)], [t("USAGE_USERS"), num.format(u.users.length)]]} />
        <Kpi titleText={t("USAGE_ASSISTED")} subtitleText={t("USAGE_THIS_MONTH")} value={num.format(totals.assisted)}
          side={[[t("USAGE_PER_CONFIG"), totals.assisted ? usd(totals.cost / totals.assisted) : "—"]]} />
        {/* Cached prompt tokens cost a tenth of fresh ones: the share read from the cache is the lever. */}
        <Kpi titleText={t("USAGE_CACHE_HIT")} subtitleText={t("USAGE_CACHE_HIT_SUB")} value={prompt ? pct.format(totals.cacheRead / prompt) : "—"}
          side={[[t("USAGE_COL_INPUT"), num.format(prompt)], [t("USAGE_COL_OUTPUT"), num.format(totals.output)]]} />
      </div>

      <Card accessibleName={t("USAGE_DAILY")} header={<CardHeader titleText={t("USAGE_DAILY")} subtitleText={t("USAGE_THIS_MONTH")} />}>
          <div style={{ padding: "0 0.5rem 0.5rem" }}>
            {totals.calls ? (
              <ColumnChart {...CHART} dataset={u.days} noLegend
                dimensions={[{ accessor: "at", formatter: (d: string) => String(Number(d.slice(8))) }]}
                measures={[{ accessor: "cost", label: t("USAGE_COST"), formatter: usd, hideDataLabel: true }]} />
            ) : empty}
          </div>
        </Card>
      <div style={grid("22rem")}>
        <Card accessibleName={t("USAGE_MONTHLY")} header={<CardHeader titleText={t("USAGE_MONTHLY")} subtitleText={t("USAGE_MONTHLY_SUB")} />}>
          <div style={{ padding: "0 0.5rem 0.5rem" }}>
            <ColumnChart {...CHART} dataset={u.months} noLegend
              // extendDomain: the axis reaches the limit with nice ticks, or a month under it would hide the line.
              // A plain-string label is centred on the line, which strikes it through: it sits above it (recharts'
              // insideBottom — and the chart's 20px top margin holds it when the limit is the top tick).
              chartConfig={{ ...CHART.chartConfig, referenceLine: { value: u.limit, color: "var(--sapCriticalColor)", ifOverflow: "extendDomain",
                label: { value: t("USAGE_LIMIT"), position: "insideBottomRight", fill: "var(--sapCriticalTextColor)", fontSize: 12 } } }}
              dimensions={[{ accessor: "at", formatter: (m: string) => monthName.format(new Date(`${m}-01T00:00:00Z`)) }]}
              measures={[{ accessor: "cost", label: t("USAGE_COST"), formatter: usd, hideDataLabel: true }]} />
          </div>
        </Card>
        <Card accessibleName={t("USAGE_BY_KIND")} header={<CardHeader titleText={t("USAGE_BY_KIND")} subtitleText={t("USAGE_THIS_MONTH")} />}>
          <div style={{ padding: "0 0.5rem 0.5rem" }}>
            {kinds.length ? (
              <DonutChart {...CHART} dataset={kinds} dimension={{ accessor: "label" }}
                measure={{ accessor: "cost", formatter: usd, hideDataLabel: true }} />
            ) : empty}
          </div>
        </Card>
      </div>

      <Grid title={t("USAGE_BY_USER")} columns={columns} state={state} onStateChange={(p) => setState((s) => ({ ...s, ...p }))}
        rows={rows} loadAll={async () => rows} keyOf={(r) => String(r.userId)} cellTemplates={cellTemplates}
        exportName={t("USAGE_TITLE")} fill={false} noDataText={t("USAGE_EMPTY")} />
    </FlexBox>
  );
}
