import { useEffect, useMemo, useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import {
  AnalyticalCardHeader, Card, CardHeader, FlexBox, IllustratedMessage, NumericSideIndicator, Tag, Text, Title,
  ToggleButton, Toolbar, ToolbarButton, ToolbarItem,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import {
  BarChart, BulletChart, ColumnChart, ColumnChartWithTrend, ComposedChart, DonutChart, LineChart, PieChart, RadarChart,
  RadialChart, ScatterChart,
} from "@ui5/webcomponents-react-charts";
import { Grid, type GridState } from "@confire/ui/list-report/Grid.tsx";
import { FilterHeader } from "@confire/ui/list-report/FilterHeader.tsx";
import { sameState } from "@confire/ui/views.ts";
import { PageMessages } from "@confire/ui/PageMessages.tsx";
import { useEntityNav } from "@confire/ui/EntityLink.tsx";
import { formatLocale } from "@confire/ui/format.ts";
import { resolveColumns, useFieldConstraintsOf, type Constraints, type EntityConstraints } from "@confire/ui/metadata.ts";
import type { FilterField, FilterValue, ListColumn, Row } from "@confire/ui/types.ts";
import { b1Feature } from "../features/b1/index.ts";
import { useI18n } from "../i18n.ts";
import {
  chartComponent, chartProps, filterBar, filterRows, formatValue, reportConstraints, reportMessages, sortRows,
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

export function ReportView({ report, result, busy, failed, actions, onChip, onRefresh, onSave, onFilter }: {
  report: Report; result: Result | null; busy: boolean; failed: string | null;
  /** the page's own actions (rename, delete), after Save */
  actions?: ReactNode;
  /** the assumption chips' click; none = no chips (not editing) */
  onChip?: (label: string) => void; onRefresh: () => void; onSave: (saved: boolean) => void;
  /** the filter bar's Go: run again with these values, by field */
  onFilter: (values: Record<string, FilterValue>) => void;
}) {
  const i18n = useI18n();
  const t = (k: string, ...a: string[]) => i18n.getText(k, ...a);
  const locale = formatLocale();
  const currency = result?.currency ?? null;
  const fmt = (v: number | null, f: Format) => formatValue(v, f, currency, locale);
  const [filter, setFilter] = useState<Filter | null>(null);
  const def = report.definition;

  const title = report.title || def?.title || "";
  // The SAP sets the definition reads, with their metadata: what a List Report labels its columns by.
  const entities = useMemo(() => [...new Set(Object.values(def?.datasets ?? {})
    .flatMap((d) => d.from.filter((s) => s.source === "b1").map((s) => s.entity)))], [def]);
  const metaList = useFieldConstraintsOf(entities);
  const metaOf = useMemo(() => new Map(entities.map((e, i) => [e, metaList[i]])), [entities, metaList]);
  const meta = useMemo(() => reportConstraints(metaList), [metaList]);
  // The bar shows what the result was filtered by; Go runs again. Memoized on the result: the bar
  // copies the applied values into its draft whenever their identity changes.
  const bar = useMemo(() => filterBar(result?.filters ?? [], meta), [result, meta]);
  const messages = useMemo(() => reportMessages(result, failed, title, t), [result, failed, title]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!def) return null;
  const read = result ? new Date(result.readAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : "";
  const rows = result ? Object.values(result.datasets).reduce((s, d) => s + d.rows, 0) : 0;
  const kpis = result?.widgets.filter((w): w is KpiResult => w.kind === "kpi") ?? [];
  const charts = result?.widgets.filter((w): w is ChartResult => w.kind === "chart") ?? [];
  const tables = result?.widgets.filter((w): w is TableResult => w.kind === "table") ?? [];

  return (
    <FlexBox direction="Column" gap="1rem" style={{ padding: "1rem 1.5rem 2rem", fontFamily: "var(--sapFontFamily)" }}>
      <FlexBox justifyContent="SpaceBetween" alignItems="Start" wrap="Wrap" gap="0.5rem">
        <FlexBox direction="Column" gap="0.25rem" style={{ minWidth: 0 }}>
          <Title level="H3" wrappingType="Normal">{title}</Title>
          {def.subtitle ? <Text>{def.subtitle}</Text> : null}
          {result ? <Text style={muted}>{t("REPORT_LIVE", read, new Intl.NumberFormat(locale).format(rows))}</Text> : null}
        </FlexBox>
        {/* A Toolbar, so a narrow pane (the chat docked) overflows the actions instead of wrapping
            them; it measures only its own item types, hence the ToolbarItems. */}
        <Toolbar design="Transparent" accessibleName={t("REPORT_ACTIONS")} overflowButtonAccessibleName={t("REPORT_ACTIONS")}
          style={{ flex: "1 1 18rem", width: "auto" }}>
          <ToolbarItem overflowPriority="NeverOverflow">
            <PageMessages messages={messages} okText={t("REPORT_NO_ISSUES")} onSection={() => {}} openOn={failed ? 1 : 0} />
          </ToolbarItem>
          <ToolbarButton design="Transparent" icon="refresh" disabled={busy} text={t("REPORT_REFRESH")} onClick={onRefresh} />
          {/* A toggle, so "saved" is announced as a pressed state rather than read off an icon. */}
          <ToolbarItem overflowPriority="NeverOverflow">
            <ToggleButton pressed={report.saved} icon={report.saved ? "favorite" : "add-favorite"}
              onClick={() => onSave(!report.saved)}>{t(report.saved ? "REPORT_SAVED" : "REPORT_SAVE")}</ToggleButton>
          </ToolbarItem>
          {actions}
        </Toolbar>
      </FlexBox>

      {onChip && def.assumptions.length ? (
        <FlexBox wrap="Wrap" gap="0.5rem">
          {def.assumptions.map((a) => (
            <Tag key={a.label} interactive design="Information" onClick={() => onChip(a.label)}>{`${a.label}: ${a.value}`}</Tag>
          ))}
        </FlexBox>
      ) : null}

      {bar.pool.length ? <ReportFilters pool={bar.pool} applied={bar.values} onFilter={onFilter} /> : null}

      {result ? (
        <>
          {kpis.length ? <div style={grid("20rem")}>{kpis.map((k, i) => <Kpi key={i} k={k} fmt={fmt} t={t} />)}</div> : null}
          {charts.length ? (
            <div style={grid("22rem")}>
              {charts.map((c, i) => (
                <ChartCard key={i} c={c} fmt={fmt} t={t} meta={meta} active={filter?.dimension === c.dimension ? filter.value : null}
                  onPick={(value) => setFilter(value === null || value === OTHER ? null : { dimension: c.dimension, value })} />
              ))}
            </div>
          ) : null}
          {tables.map((tr, i) => <ReportTable key={i} tr={tr} title={title} filter={filter} onClear={() => setFilter(null)} t={t} metaOf={metaOf} meta={meta} />)}
        </>
      ) : (
        // Loading: the draft's own layout, each chart's placeholder shimmering.
        <div style={grid("22rem")}>
          {def.widgets.filter((w) => w.kind !== "table").map((w, i) => (
            <Card key={i} accessibleName={w.title} header={<CardHeader titleText={w.title} />}>
              <ColumnChart loading dataset={[]} dimensions={[{ accessor: "x" }]} measures={[{ accessor: "y" }]} style={{ height: CHART_HEIGHT }} />
            </Card>
          ))}
        </div>
      )}
    </FlexBox>
  );
}

type T = (k: string, ...a: string[]) => string;

/** The report's filter bar: the list's FilterHeader in a card, every field of the report's data in
 *  Adapt Filters. Which are shown is this page's (a new definition shows its own again); Go runs on
 *  the values, Clear on the definition's defaults. */
function ReportFilters({ pool, applied, onFilter }: {
  pool: FilterField[]; applied: Record<string, FilterValue>;
  onFilter: (values: Record<string, FilterValue>) => void;
}) {
  const declared = useMemo(() => pool.filter((f) => f.visible !== false).map((f) => f.key), [pool]);
  const [shown, setShown] = useState<string[] | null>(null);
  useEffect(() => setShown(null), [declared.join("\n")]); // eslint-disable-line react-hooks/exhaustive-deps
  // Memoized: FilterHeader copies the applied values into its draft whenever their identity changes.
  const state = useMemo(() => ({ adaptFilterKeys: shown ?? declared, filterValues: applied, searchTerm: "" }), [shown, declared, applied]);
  return (
    <Card>
      <div style={{ padding: "0.25rem 1rem 0.5rem" }}>
        <FilterHeader pool={pool} state={state} showSearch={false}
          onApply={(next) => {
            setShown(next.adaptFilterKeys);
            // Adapt Filters applies too: run again only when the values changed.
            if (!sameState(next.filterValues, applied)) onFilter(next.filterValues);
          }} />
      </div>
    </Card>
  );
}

function Kpi({ k, fmt, t }: { k: KpiResult; fmt: (v: number | null, f: Format) => string; t: T }) {
  const trend = k.deviation === null || k.deviation === 0 ? "None" : k.deviation > 0 ? "Up" : "Down";
  const pct = k.deviation === null ? null : `${k.deviation > 0 ? "+" : ""}${fmt(k.deviation, "percent")}`;
  return (
    <Card accessibleName={k.title} header={(
      <AnalyticalCardHeader titleText={k.title} value={fmt(k.value, k.format)} trend={trend}>
        {k.compare !== null ? <NumericSideIndicator titleText={t("REPORT_COMPARE")} number={fmt(k.compare, k.format)} /> : null}
        {pct ? <NumericSideIndicator titleText={t("REPORT_DEVIATION")} number={pct} /> : null}
        {k.target !== null && k.compare === null ? <NumericSideIndicator titleText={t("REPORT_TARGET")} number={fmt(k.target, k.format)} /> : null}
      </AnalyticalCardHeader>
    )} />
  );
}

function ChartCard({ c, fmt, t, meta, active, onPick }: {
  c: ChartResult; fmt: (v: number | null, f: Format) => string; t: T; meta: Constraints; active: string | null; onPick: (value: string | null) => void;
}) {
  // "Other" and an enum's members (bost_Open) are drawn as a reader says them; the filter still
  // sees the server's value, mapped back off the drawn one.
  const names = new Map<unknown, string>([[OTHER, t("REPORT_OTHER")], ...(meta[c.dimension]?.Options ?? []).map((o) => [o.value, o.label] as const)]);
  const back = new Map([...names].map(([v, l]) => [l, v]));
  const label = (v: unknown) => names.get(v) ?? v;
  const shown: ChartResult = { ...c, rows: c.rows.map((r) => ({ ...r, [c.dimension]: label(r[c.dimension]) as string })), measures: c.measures.map((m) => ({ ...m, label: String(label(m.label)) })) };
  const C = CHARTS[chartComponent(c.chart)];
  const pick = (e: CustomEvent) => {
    const d = (e.detail ?? {}) as { payload?: Record<string, unknown> };
    const v = d.payload?.[c.dimension];
    const raw = back.get(v as string) ?? v;
    onPick(raw === undefined || raw === null || raw === active ? null : String(raw));
  };
  const common = { noAnimation: true, chartConfig: { resizeDebounce: 0 }, style: { height: CHART_HEIGHT }, onDataPointClick: pick };
  const first = shown.measures[0];
  let body;
  if (!shown.rows.length || !first) body = <IllustratedMessage name="NoData" design="Spot" titleText={t("REPORT_EMPTY")} style={{ height: CHART_HEIGHT }} />;
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
    // A wide chart takes the whole row: `span 2` overflows when only one track fits (a laptop with the chat docked).
    <Card accessibleName={c.title} style={c.size === "wide" ? { gridColumn: "1 / -1" } : undefined}
      header={<CardHeader titleText={c.title} subtitleText={c.note ?? (active ? t("REPORT_FILTER", String(label(active))) : undefined)} />}>
      <div style={{ padding: "0 0.5rem 0.5rem" }}>{body}</div>
    </Card>
  );
}

const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v);

function ReportTable({ tr, title, filter, onClear, t, metaOf, meta }: {
  tr: TableResult; title: string; filter: Filter | null; onClear: () => void; t: T;
  metaOf: Map<string, EntityConstraints | undefined>; meta: Constraints;
}) {
  const nav = useEntityNav();
  const [state, setState] = useState<GridState>({ columns: tr.columns, sortBy: [], groupBy: tr.groupBy, columnWidths: {} });
  // The List Report's columns: label, type and enum names from the metadata of the sets this table's
  // rows came from (the whole report's while it has none). A lookup or derive keeps the name the
  // definition gave it, typed off its values. ponytail: no codeNames (useCodeNames) — a group code
  // shows as its code; add the B1 feature's codeNames here if users ask.
  const own = useMemo(() => {
    const sets = [...new Set(tr.rows.map((r) => String(r._entity ?? "")))].filter((e) => metaOf.has(e));
    return sets.length ? reportConstraints(sets.map((e) => metaOf.get(e))) : meta;
  }, [tr.rows, metaOf, meta]);
  const columns: ListColumn[] = useMemo(() => resolveColumns(tr.columns.map((key) => {
    const sample = tr.rows.find((r) => r[key] !== null && r[key] !== undefined)?.[key];
    return {
      key, groupable: true, sortable: true,
      ...(key === "_source" ? { label: t("REPORT_SOURCE"), type: "string" as const } : own[key] ? {}
        : { label: key, type: typeof sample === "number" ? "number" as const : isDate(sample) ? "date" as const : "string" as const }),
    };
  }), own), [tr.columns, tr.rows, own]); // eslint-disable-line react-hooks/exhaustive-deps
  const filtered = filter && tr.rows.some((r) => filter.dimension in r) ? filterRows(tr.rows, filter.dimension, filter.value) : tr.rows;
  // Sorting is the grid's to ask and ours to do: every row is here.
  const rows = useMemo(() => sortRows(filtered, state.sortBy), [filtered, state.sortBy]);
  const open = (r: Row) => {
    const entity = String(r._entity ?? "");
    const f = b1Feature(entity);
    const key = f ? r[f.keyField] : undefined;
    if (f && key !== undefined && key !== null) nav(`/b1/${entity}`, key);
  };
  return (
    <FlexBox direction="Column" gap="0.5rem">
      {filter ? (
        <FlexBox>
          <Tag interactive design="Set2" onClick={onClear}>{`${t("REPORT_FILTER", own[filter.dimension]?.Options?.find((o) => o.value === filter.value)?.label ?? filter.value)} ✕`}</Tag>
        </FlexBox>
      ) : null}
      <Grid title={tr.title} columns={columns} state={state} onStateChange={(p) => setState((s) => ({ ...s, ...p }))}
        rows={rows as Row[]} total={filter ? rows.length : tr.total ?? rows.length} loadAll={async () => rows as Row[]}
        exportName={title} fill={false} expandGroups visibleRows={12} onRowClick={open} />
    </FlexBox>
  );
}
