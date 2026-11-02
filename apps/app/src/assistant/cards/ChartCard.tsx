import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  AnalyticalCardHeader, Button, Card, CardHeader, Link, ObjectStatus, SegmentedButton, SegmentedButtonItem, Text,
} from "@ui5/webcomponents-react";
import { BarChart, ColumnChart, DonutChart, LineChart } from "@ui5/webcomponents-react-charts";
import { useCanOpen } from "@confire/ui/EntityLink.tsx";
import { formatLocale } from "@confire/ui/format.ts";
import { money } from "@confire/ui/money.ts";
import { useCurrency } from "../../orpc.ts";
import { b1Feature } from "../../features/b1/index.ts";
import { chartChoices, chartCsv, drillLink, type Chart, type ReportOut } from "./chart.ts";
import { TableCard } from "./kit.tsx";
import type { CardLink } from "./data.ts";

// A report tool's answer (reports_sap / reports_configs) as a chart in the chat: SAP's own UI5 charts,
// so the theme's chart palette, its dark mode and its high contrast come with them. The figures are
// the server's (report.ts); the card only draws them. What the user may do with it is the card's own,
// never a model call: switch the chart (or to a table), open the records behind a bar or a slice, open
// the whole list, download the figures as CSV.

const ICON: Record<Chart, string> = {
  column: "vertical-bar-chart", bar: "horizontal-bar-chart", line: "line-chart", donut: "donut-chart",
  pie: "pie-chart", table: "table-view", kpi: "business-objects-experience",
};
const HEIGHT = { height: "16rem", width: "100%" } as const;
const BODY = { padding: "0 0.5rem 0.5rem" } as const;
const FOOTER = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem", padding: "0.25rem 1rem 0.75rem" } as const;

type T = (key: string, ...a: Array<string | number>) => string;

export function ChartCard({ out, input, tool, t, label }: {
  out: ReportOut;
  /** the tool's input: its filter, for the drill-down's link */
  input: { entity?: string; filter?: { field: string; op: string; value: unknown }[] };
  tool: string;
  t: T;
  /** a dimension value as the user reads it (a document's status, a configuration's status) */
  label?: (field: string, value: string) => string;
}) {
  const navigate = useNavigate({ from: "/$slug" });
  const canOpen = useCanOpen();
  const currency = useCurrency();
  const choices = chartChoices(out);
  const [chart, setChart] = useState<Chart>(choices.includes(out.chart) ? out.chart : choices[0]!);

  const compact = useMemo(() => new Intl.NumberFormat(formatLocale(), { notation: "compact", maximumFractionDigits: 1 }), []);
  const plain = useMemo(() => new Intl.NumberFormat(formatLocale(), { maximumFractionDigits: 2 }), []);
  const fmt = (i: number) => (v: unknown) => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return "";
    return out.measures[i]?.money ? money(n, currency) : plain.format(n);
  };
  const short = (i: number) => (v: unknown) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? (out.measures[i]?.money && currency ? `${compact.format(n)} ${currency}` : compact.format(n)) : "";
  };
  const shown = (r: ReportOut["rows"][number]) =>
    r.key !== null && out.dimension && label && !out.dimension.bucket ? label(out.dimension.field, r.key) : r.label;

  // UI5's charts take a flat dataset and name each measure by its accessor.
  // `drill`, not `key`: the charts spread a row into their elements' props, where `key` is React's.
  const dataset = useMemo(() => out.rows.map((r) => ({
    label: shown(r), drill: r.key, ...Object.fromEntries(r.values.map((v, i) => [`m${i}`, v])),
  })), [out]); // eslint-disable-line react-hooks/exhaustive-deps
  const measures = out.measures.map((m, i) => ({
    // A series' values are a field's values too (a document status): read as the user reads them.
    accessor: `m${i}`, label: out.series && label ? label(out.series.field, m.label) : m.label, formatter: short(i),
    ...(out.series ? { stackId: "s" } : {}),
    // A few bars carry their figure; a dense chart reads off the tooltip.
    hideDataLabel: out.rows.length > 12 || out.measures.length > 1,
  }));
  const dimensions = [{ accessor: "label" }];

  // Only an entity with a list page in the app, and only by a field that list can filter on.
  const feature = tool === "reports_sap" && input.entity ? b1Feature(input.entity) : undefined;
  const route = feature ? `/b1/${feature.entity}` : null;
  const may = !!route && canOpen(route);
  const pool = useMemo(() => new Set([...(feature?.list.filterFields ?? []).map((f) => f.key), ...(feature?.list.columns ?? []).map((c) => c.key)]
    .map((k) => k.toLowerCase())), [feature]);
  const open = (l: CardLink) => void navigate({ to: `/$slug${l.to}` as "/$slug", search: (l.search ?? {}) as never });
  const linkOf = (key: string | null) => (may && key && out.dimension ? drillLink(route!, input.filter ?? [], out.dimension.field, key, pool) : null);
  const drill = (key: unknown) => {
    const l = typeof key === "string" ? linkOf(key) : null;
    if (l) open(l);
  };
  const onPoint = (e: CustomEvent) => drill((e.detail as { payload?: { drill?: unknown } }).payload?.drill);
  const drillable = !!out.dimension && out.rows.some((r) => linkOf(r.key));

  const download = () => {
    const blob = new Blob([chartCsv(out, shown)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${out.title.replace(/[^\p{L}\p{N} _-]+/gu, "").trim() || "report"}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
  };

  const body = ((): ReactNode => {
    if (!out.rows.length) return <div style={{ padding: "0.5rem 1rem 1rem" }}><Text>{t("ASSISTANT_CARD_NONE")}</Text></div>;
    switch (chart) {
      case "kpi":
        return (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(11rem, 1fr))", gap: "0.5rem", padding: "0 1rem 0.75rem" }}>
            {out.measures.map((m, i) => {
              const v = out.rows[0]?.values[i] ?? 0;
              return (
                <Card key={i} header={<AnalyticalCardHeader titleText={m.label} value={compact.format(v)}
                  scale={m.money ? currency : undefined} description={fmt(i)(v)} />} />
              );
            })}
          </div>
        );
      case "table":
        return (
          <TableCard bare title="" label={out.title}
            columns={[{ key: "label", label: out.dimension?.label ?? "" }, ...out.measures.map((m, i) => ({ key: `m${i}`, label: m.label, end: true }))]}
            rows={out.rows.map((r, i) => ({
              id: String(i),
              cells: { label: shown(r), ...Object.fromEntries(r.values.map((v, j) => [`m${j}`, fmt(j)(v)])) },
              ...(linkOf(r.key) ? { onOpen: () => drill(r.key) } : {}),
            }))} />
        );
      case "donut":
      case "pie":
        return (
          <DonutChart style={HEIGHT} dataset={dataset} dimension={dimensions[0]!} onDataPointClick={onPoint}
            measure={{ accessor: "m0", formatter: short(0) }}
            chartConfig={chart === "pie" ? { innerRadius: "0%" } : undefined} />
        );
      case "line":
        return <LineChart style={HEIGHT} dataset={dataset} dimensions={dimensions} measures={measures} onDataPointClick={onPoint} noLegend={measures.length < 2} />;
      case "bar":
        return (
          <BarChart style={{ ...HEIGHT, height: `${Math.max(12, Math.min(28, out.rows.length * 2 + 4))}rem` }} dataset={dataset}
            dimensions={dimensions} measures={measures} onDataPointClick={onPoint} noLegend={measures.length < 2} />
        );
      default:
        return <ColumnChart style={HEIGHT} dataset={dataset} dimensions={dimensions} measures={measures} onDataPointClick={onPoint} noLegend={measures.length < 2} />;
    }
  })();

  const counted = out.total !== null && out.total > out.scanned
    ? t("ASSISTANT_CHART_SCANNED_OF", String(out.scanned), String(out.total))
    : t("ASSISTANT_CHART_SCANNED", String(out.scanned));
  const all = may ? drillLink(route!, input.filter ?? [], null, null, pool) : null;
  const source = tool === "reports_configs" ? t("ASSISTANT_CARD_CONFIGS") : out.entity;

  return (
    <Card header={
      <CardHeader titleText={out.title} subtitleText={[source, counted].join(" · ")}
        action={choices.length > 1 ? (
          <SegmentedButton accessibleName={t("ASSISTANT_CHART_VIEW")}
            onSelectionChange={(e) => {
              const k = (e.detail.selectedItems[0] as HTMLElement | undefined)?.dataset.chart as Chart | undefined;
              if (k) setChart(k);
            }}>
            {choices.map((c) => (
              <SegmentedButtonItem key={c} data-chart={c} icon={ICON[c]} selected={c === chart}
                tooltip={t(`ASSISTANT_CHART_${c.toUpperCase()}`)} accessibleName={t(`ASSISTANT_CHART_${c.toUpperCase()}`)} />
            ))}
          </SegmentedButton>
        ) : undefined} />
    }>
      <div style={BODY}>{body}</div>
      <div style={FOOTER}>
        {out.truncated ? <ObjectStatus state="Critical" showDefaultIcon>{t("ASSISTANT_CHART_TRUNCATED")}</ObjectStatus> : null}
        {drillable && chart !== "kpi" ? <Text style={{ color: "var(--sapContent_LabelColor)" }}>{t("ASSISTANT_CHART_DRILL")}</Text> : null}
        <span style={{ flex: 1 }} />
        {all ? <Link onClick={() => open(all)}>{t("ASSISTANT_CHART_OPEN_LIST")}</Link> : null}
        <Button design="Transparent" icon="download" tooltip={t("ASSISTANT_CHART_DOWNLOAD")} accessibleName={t("ASSISTANT_CHART_DOWNLOAD")}
          onClick={download} />
      </div>
    </Card>
  );
}
