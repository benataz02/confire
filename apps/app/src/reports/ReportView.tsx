import { useMemo, useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import {
  AnalyticalCardHeader, Button, Card, CardHeader, FlexBox, NumericSideIndicator, Tag, Text, Title,
} from "@ui5/webcomponents-react";
import {
  BarChart, BulletChart, ColumnChart, ColumnChartWithTrend, ComposedChart, DonutChart, LineChart, PieChart, RadarChart,
  RadialChart, ScatterChart,
} from "@ui5/webcomponents-react-charts";
import { Grid, type GridState } from "@confire/ui/list-report/Grid.tsx";
import { PageMessages, type PageMessage } from "@confire/ui/PageMessages.tsx";
import { useEntityNav } from "@confire/ui/EntityLink.tsx";
import { formatLocale } from "@confire/ui/format.ts";
import type { ListColumn, Row } from "@confire/ui/types.ts";
import { b1Feature } from "../features/b1/index.ts";
import { useI18n } from "../i18n.ts";
import {
  chartComponent, chartProps, filterRows, formatValue,
  type ChartComponent, type ChartResult, type Format, type KpiResult, type Report, type Result, type TableResult,
} from "./widgets.ts";

// A report drawn (reports spec §6.2): its header and messages, the assistant's reading as chips, the
// KPI row, the charts in a grid and the documents behind them. Every figure is the server's result;
// a click on a category filters the table, in the browser, over rows the result already holds.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CHARTS: Record<ChartComponent, ComponentType<any>> = {
  ColumnChart, BarChart, LineChart, ComposedChart, ColumnChartWithTrend, DonutChart, PieChart, RadialChart, BulletChart, ScatterChart, RadarChart,
};
const OTHER = "Other";
const CHART_HEIGHT = "16rem";
const grid = (min: string): CSSProperties => ({ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${min}, 1fr))`, gap: "1rem" });
const muted: CSSProperties = { color: "var(--sapContent_LabelColor)" };

export type Filter = { dimension: string; value: string };

export function ReportView({ report, result, busy, failed, actions, onChip, onRefresh, onSave }: {
  report: Report; result: Result | null; busy: boolean; failed: string | null;
  /** the page's own actions (rename, delete), after Save */
  actions?: ReactNode;
  onChip: (label: string) => void; onRefresh: () => void; onSave: (saved: boolean) => void;
}) {
  const i18n = useI18n();
  const t = (k: string, ...a: string[]) => i18n.getText(k, ...a);
  const locale = formatLocale();
  const currency = result?.currency ?? null;
  const fmt = (v: number | null, f: Format) => formatValue(v, f, currency, locale);
  const [filter, setFilter] = useState<Filter | null>(null);
  const def = report.definition;

  const messages = useMemo((): PageMessage[] => {
    const group = def?.title ?? "";
    const out: PageMessage[] = [];
    if (failed) out.push({ id: "failed", type: "Negative", text: t("REPORT_FAILED"), detail: failed, group });
    for (const [id, st] of Object.entries(result?.datasets ?? {})) {
      if (st.partial) out.push({ id: `p:${id}`, type: "Critical", text: t("REPORT_PARTIAL", id), detail: t("REPORT_PARTIAL_DETAIL", String(st.partial.read), st.partial.total === null ? "…" : String(st.partial.total)), group });
      if (st.fellBack) out.push({ id: `f:${id}`, type: "Information", text: t("REPORT_FELL_BACK", id), detail: t("REPORT_FELL_BACK_DETAIL"), group });
    }
    return out;
  }, [result, failed, def?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!def) return null;
  const read = result ? new Date(result.readAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : "";
  const rows = result ? Object.values(result.datasets).reduce((s, d) => s + d.rows, 0) : 0;
  const kpis = result?.widgets.filter((w): w is KpiResult => w.kind === "kpi") ?? [];
  const charts = result?.widgets.filter((w): w is ChartResult => w.kind === "chart") ?? [];
  const tables = result?.widgets.filter((w): w is TableResult => w.kind === "table") ?? [];

  return (
    <FlexBox direction="Column" style={{ gap: "1rem", padding: "1rem 1.5rem 2rem", fontFamily: "var(--sapFontFamily)" }}>
      <FlexBox justifyContent="SpaceBetween" alignItems="Start" wrap="Wrap" style={{ gap: "0.5rem" }}>
        <FlexBox direction="Column" style={{ gap: "0.25rem" }}>
          <Title level="H3">{def.title}</Title>
          {def.subtitle ? <Text>{def.subtitle}</Text> : null}
          {result ? <Text style={muted}>{t("REPORT_LIVE", read, new Intl.NumberFormat(locale).format(rows))}</Text> : null}
        </FlexBox>
        <FlexBox alignItems="Center" style={{ gap: "0.5rem" }}>
          <PageMessages messages={messages} okText={t("REPORT_NO_ISSUES")} onSection={() => {}} openOn={failed ? 1 : 0} />
          <Button design="Transparent" icon="refresh" disabled={busy} onClick={onRefresh}>{t("REPORT_REFRESH")}</Button>
          <Button design={report.saved ? "Default" : "Emphasized"} icon={report.saved ? "accept" : "add-favorite"}
            onClick={() => onSave(!report.saved)}>{t(report.saved ? "REPORT_SAVED" : "REPORT_SAVE")}</Button>
          {actions}
        </FlexBox>
      </FlexBox>

      {def.assumptions.length ? (
        <FlexBox wrap="Wrap" style={{ gap: "0.5rem" }}>
          {def.assumptions.map((a) => (
            <Tag key={a.label} interactive design="Information" onClick={() => onChip(a.label)}>{`${a.label}: ${a.value}`}</Tag>
          ))}
        </FlexBox>
      ) : null}

      {result ? (
        <>
          {kpis.length ? <div style={grid("13rem")}>{kpis.map((k, i) => <Kpi key={i} k={k} fmt={fmt} t={t} />)}</div> : null}
          {charts.length ? (
            <div style={grid("22rem")}>
              {charts.map((c, i) => (
                <ChartCard key={i} c={c} fmt={fmt} t={t} active={filter?.dimension === c.dimension ? filter.value : null}
                  onPick={(value) => setFilter(value === null || value === OTHER ? null : { dimension: c.dimension, value })} />
              ))}
            </div>
          ) : null}
          {tables.map((tr, i) => <ReportTable key={i} tr={tr} title={def.title} filter={filter} onClear={() => setFilter(null)} t={t} />)}
        </>
      ) : (
        // Loading: the draft's own layout, each chart's placeholder shimmering.
        <div style={grid("22rem")}>
          {def.widgets.filter((w) => w.kind !== "table").map((w, i) => (
            <Card key={i} header={<CardHeader titleText={w.title} />}>
              <ColumnChart loading dataset={[]} dimensions={[{ accessor: "x" }]} measures={[{ accessor: "y" }]} style={{ height: CHART_HEIGHT }} />
            </Card>
          ))}
        </div>
      )}
    </FlexBox>
  );
}

type T = (k: string, ...a: string[]) => string;

function Kpi({ k, fmt, t }: { k: KpiResult; fmt: (v: number | null, f: Format) => string; t: T }) {
  const trend = k.deviation === null || k.deviation === 0 ? "None" : k.deviation > 0 ? "Up" : "Down";
  const pct = k.deviation === null ? null : `${k.deviation > 0 ? "+" : ""}${fmt(k.deviation, "percent")}`;
  return (
    <Card header={(
      <AnalyticalCardHeader titleText={k.title} value={fmt(k.value, k.format)} trend={trend}>
        {k.compare !== null ? <NumericSideIndicator titleText={t("REPORT_COMPARE")} number={fmt(k.compare, k.format)} /> : null}
        {pct ? <NumericSideIndicator titleText={t("REPORT_DEVIATION")} number={pct} /> : null}
        {k.target !== null && k.compare === null ? <NumericSideIndicator titleText={t("REPORT_TARGET")} number={fmt(k.target, k.format)} /> : null}
      </AnalyticalCardHeader>
    )} />
  );
}

function ChartCard({ c, fmt, t, active, onPick }: {
  c: ChartResult; fmt: (v: number | null, f: Format) => string; t: T; active: string | null; onPick: (value: string | null) => void;
}) {
  const label = (v: unknown) => (v === OTHER ? t("REPORT_OTHER") : v);
  // "Other" is drawn in the user's language; the filter still sees the server's value.
  const shown: ChartResult = { ...c, rows: c.rows.map((r) => ({ ...r, [c.dimension]: label(r[c.dimension]) as string })), measures: c.measures.map((m) => ({ ...m, label: String(label(m.label)) })) };
  const C = CHARTS[chartComponent(c.chart)];
  const pick = (e: CustomEvent) => {
    const d = (e.detail ?? {}) as { payload?: Record<string, unknown> };
    const v = d.payload?.[c.dimension];
    onPick(v === undefined || v === null || v === active ? null : v === t("REPORT_OTHER") ? OTHER : String(v));
  };
  const common = { noAnimation: true, chartConfig: { resizeDebounce: 0 }, style: { height: CHART_HEIGHT }, onDataPointClick: pick };
  const first = shown.measures[0];
  let body;
  if (!shown.rows.length || !first) body = <Text style={{ ...muted, padding: "1rem" }}>{t("REPORT_EMPTY")}</Text>;
  else if (c.chart === "donut" || c.chart === "pie") {
    body = <C {...common} dataset={shown.rows} dimension={{ accessor: c.dimension }}
      measure={{ accessor: first.key, label: first.label, formatter: (v: number) => fmt(v, first.format) }} />;
  } else if (c.chart === "radial") {
    const value = Number(shown.rows[0]![first.key] ?? 0);
    const total = c.target ?? shown.rows.reduce((s, r) => s + Number(r[first.key] ?? 0), 0);
    body = <RadialChart noAnimation style={{ height: CHART_HEIGHT }} value={value} maxValue={total || 1} displayValue={fmt(value, first.format)} />;
  } else if (c.chart === "scatter") {
    const [x, y] = shown.measures;
    body = <C {...common} dataset={[{ label: c.title, data: shown.rows }]}
      measures={[x, y].filter(Boolean).map((m, i) => ({ accessor: m!.key, label: m!.label, axis: i ? "y" : "x", formatter: (v: number) => fmt(v, m!.format) }))} />;
  } else {
    body = <C {...common} {...chartProps(shown, (v, f) => fmt(v, f))} />;
  }
  return (
    <Card style={c.size === "wide" ? { gridColumn: "span 2" } : undefined}
      header={<CardHeader titleText={c.title} subtitleText={c.note ?? (active ? t("REPORT_FILTER", String(label(active))) : undefined)} />}>
      <div style={{ padding: "0 0.5rem 0.5rem" }}>{body}</div>
    </Card>
  );
}

const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v);

function ReportTable({ tr, title, filter, onClear, t }: { tr: TableResult; title: string; filter: Filter | null; onClear: () => void; t: T }) {
  const nav = useEntityNav();
  const [state, setState] = useState<GridState>({ columns: tr.columns, sortBy: [], groupBy: tr.groupBy, columnWidths: {} });
  // ponytail: SAP's field names as headers (DocNum, CardName); the B1 schema's labels if users find them cryptic.
  const columns: ListColumn[] = tr.columns.map((key) => {
    const sample = tr.rows.find((r) => r[key] !== null && r[key] !== undefined)?.[key];
    return {
      key, label: key === "_source" ? t("REPORT_SOURCE") : key, groupable: true, sortable: true,
      type: typeof sample === "number" ? "number" : isDate(sample) ? "date" : "string",
    };
  });
  const filtered = filter && tr.rows.some((r) => filter.dimension in r) ? filterRows(tr.rows, filter.dimension, filter.value) : tr.rows;
  // Sorting is the grid's to ask and ours to do: every row is here.
  const rows = useMemo(() => {
    const by = state.sortBy;
    if (!by.length) return filtered;
    return [...filtered].sort((a, b) => {
      for (const s of by) {
        const x = a[s.field], y = b[s.field];
        const c = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""), undefined, { numeric: true });
        if (c) return s.direction === "desc" ? -c : c;
      }
      return 0;
    });
  }, [filtered, state.sortBy]);
  const open = (r: Row) => {
    const entity = String(r._entity ?? "");
    const f = b1Feature(entity);
    const key = f ? r[f.keyField] : undefined;
    if (f && key !== undefined && key !== null) nav(`/b1/${entity}`, key);
  };
  return (
    <FlexBox direction="Column" style={{ gap: "0.5rem" }}>
      {filter ? (
        <FlexBox>
          <Tag interactive design="Set2" onClick={onClear}>{`${t("REPORT_FILTER", filter.value)} ✕`}</Tag>
        </FlexBox>
      ) : null}
      <Grid title={tr.title} columns={columns} state={state} onStateChange={(p) => setState((s) => ({ ...s, ...p }))}
        rows={rows as Row[]} total={filter ? rows.length : tr.total ?? rows.length} loadAll={async () => rows as Row[]}
        exportName={title} fill={false} expandGroups visibleRows={12} onRowClick={open} />
    </FlexBox>
  );
}
