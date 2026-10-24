import { useMemo, useState } from "react";
import {
  Label, MultiComboBox, MultiComboBoxItem, ObjectStatus, Tag, Text, Title,
} from "@ui5/webcomponents-react";
import { LineChart } from "@ui5/webcomponents-react-charts";
import type { ModelDef } from "@confire/config-engine";
import type { client } from "../../orpc.ts";
import {
  candidateLabel, chartRows, fmt, lineKey, mergeSelection, percent, sortRows, type Sel,
} from "./runView.ts";
import { money } from "@confire/ui/money.ts";
import { useCurrency } from "../../orpc.ts";
import { useI18n } from "../../i18n.ts";
import { Grid, type CellTemplate, type GridState } from "@confire/ui/list-report/Grid.tsx";
import type { ListColumn, Row } from "@confire/ui/types.ts";

// The line's own fields. Not identifiers, so no parameter key — a column of its own — collides.
const IDX = "#i";
const QTY = "#qty";
const PRICE = "#price";
const MARGIN = "#margin";
const TOTAL = "#total";
const LOWEST = "#lowest";

const toSel = (r: Row): Sel => ({ candidateIdx: r[IDX] as number, batchQty: r[QTY] as number });
const keyOf = (r: Row) => lineKey(toSel(r));
/** Cheapest first inside each quantity — the question this list answers. */
const DEFAULT_SORT: GridState["sortBy"] = [{ field: QTY, direction: "asc" }, { field: PRICE, direction: "asc" }];

type Candidates = Awaited<ReturnType<typeof client.configs.get>>["candidates"];

// The candidates view: one grid row per candidate × batch quantity, so a ticked row IS one future
// quotation line. Each open parameter is a column and a filter. Below it, how the price moves with
// quantity. Every figure and the Lowest tag are the view's; the cap is a message-popover warning.
export function PriceAnalysis({ model, candidates: { keys, rows: candidates }, selection, onSelect, disabled }: {
  model: ModelDef;
  candidates: Candidates;
  selection: Sel[];
  onSelect: (selection: Sel[]) => void;
  /** locked (quoted), or about to be replaced: the ticks still show, they just stop taking clicks */
  disabled?: boolean;
}) {
  const currency = useCurrency();
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const batches = candidates[0]?.perBatch.map((b) => b.batchQty) ?? [];
  const paramLabel = (k: string) => model.parameters.find((p) => p.key === k)?.label ?? k;

  // Keyed on the keys' contents: a new view is a new array.
  const qtyText = t("CONFIG_QUANTITY");
  const priceText = t("CONFIG_UNIT_PRICE");
  const marginText = t("CONFIG_MARGIN");
  const totalText = t("CONFIG_TOTAL");
  const lowestText = t("CONFIG_LOWEST");
  const columns = useMemo<ListColumn[]>(() => [
    ...keys.map((k) => ({ key: k, label: paramLabel(k), groupable: true })),
    { key: QTY, label: qtyText, type: "number" as const, groupable: true },
    { key: PRICE, label: priceText, type: "number" as const },
    { key: MARGIN, label: marginText, type: "number" as const },
    { key: TOTAL, label: totalText, type: "number" as const },
  ], [keys.join(), model.parameters, qtyText, priceText, marginText, totalText]);
  // Sort, grouping and widths are the user's until the column set changes under them (a
  // recalculation that leaves other parameters open), then they start over.
  const sig = columns.map((c) => c.key).join();
  const [view, setView] = useState<{ sig: string; state: GridState } | null>(null);
  // Several quantities read as one block each; one quantity has nothing to group.
  const state: GridState = view?.sig === sig
    ? view.state
    : { columns: columns.map((c) => c.key), sortBy: DEFAULT_SORT, groupBy: batches.length > 1 ? [QTY] : [] };

  // A grid template must outlive the render (a new one is a new component type), so it reads only
  // its row and the currency.
  const cellTemplates = useMemo<Record<string, CellTemplate>>(() => ({
    [PRICE]: (r) => (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.5rem", width: "100%" }}>
        {r[LOWEST] ? <Tag design="Positive">{lowestText}</Tag> : null}
        <Text>{money(r[PRICE] as number, currency)}</Text>
      </div>
    ),
    // Negative only below zero: any other threshold would be a policy this app does not have.
    [MARGIN]: (r) => {
      const m = r[MARGIN] as number | null;
      return <ObjectStatus state={m !== null && m < 0 ? "Negative" : "None"}>{percent(m)}</ObjectStatus>;
    },
    [TOTAL]: (r) => <Text>{money(r[TOTAL] as number, currency)}</Text>,
  }), [currency, lowestText]);

  const all = candidates.flatMap((c, i) => c.perBatch.map((b): Row => ({
    ...Object.fromEntries(keys.map((k) => [k, String(c.assignment[k] ?? "—")])),
    [IDX]: i, [QTY]: b.batchQty, [PRICE]: b.unitPrice, [TOTAL]: b.total, [LOWEST]: b.lowest, [MARGIN]: b.margin,
  })));
  // One filter per column that actually varies — a single value has nothing to narrow.
  const domains = [...keys.map((k) => ({ key: k, label: paramLabel(k) })), { key: QTY, label: qtyText }]
    .map((d) => ({ ...d, values: [...new Set(all.map((r) => String(r[d.key])))] }))
    .filter((d) => d.values.length > 1);
  const rows = sortRows(
    all.filter((r) => Object.entries(filters).every(([k, vs]) => !vs.length || vs.includes(String(r[k])))),
    state.sortBy,
  );

  // Rebuilt on a refused click too: AnalyticalTable re-syncs its ticks when this object changes,
  // which is how a disabled grid puts a click back — it has no disabled selection of its own.
  const [resync, setResync] = useState(0);
  const selectedIds = useMemo(
    () => Object.fromEntries(selection.map((s) => [lineKey(s), true])),
    [selection, resync],
  );

  const chart = chartRows(candidates, selection);
  const dataset = batches.map((q, j) =>
    Object.fromEntries([["qty", q], ...chart.map((i) => [`c${i}`, candidates[i]!.perBatch[j]!.unitPrice])]));
  const label = (i: number) => candidateLabel(t, keys, candidates[i]!.assignment);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {domains.length ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem 1rem" }}>
          {domains.map((d) => (
            <div key={d.key} style={{ display: "flex", flexDirection: "column", width: "14rem" }}>
              <Label for={`flt-${d.key}`} showColon>{d.label}</Label>
              <MultiComboBox id={`flt-${d.key}`} placeholder={t("CONFIG_FILTER_ALL")} selectedValues={filters[d.key] ?? []}
                onSelectionChange={(e) =>
                  setFilters((f) => ({ ...f, [d.key]: e.detail.items.map((it) => it.value ?? "") }))}>
                {d.values.map((v) => (
                  <MultiComboBoxItem key={v} value={v} text={d.key === QTY ? fmt(Number(v)) : v} />
                ))}
              </MultiComboBox>
            </div>
          ))}
        </div>
      ) : null}
      <Text>{t("CONFIG_LINES_HINT")}</Text>
      <Grid title={t("CONFIG_LINES")} columns={columns} state={state} rows={rows} keyOf={keyOf} fill={false}
        onStateChange={(patch) => setView({ sig, state: { ...state, ...patch } })}
        cellTemplates={cellTemplates} noDataText={t("CONFIG_NO_LINES")}
        selectionMode="Multiple" selectedIds={selectedIds} expandGroups
        onSelectionChange={(picked) => {
          if (disabled) setResync((n) => n + 1);
          else onSelect(mergeSelection(selection, new Set(rows.map(keyOf)), picked.map(toSel)));
        }} />

      {/* The grid above is this chart's table view — same numbers, exact — so the chart can stay
          a shape: no data labels, a legend only once there are lines to tell apart. */}
      {chart.length ? (
        <>
          <Title level="H6" style={{ marginBlockStart: "1.25rem" }}>
            {chart.length === 1 ? t("CONFIG_CHART_ONE", label(chart[0]!)) : t("CONFIG_CHART")}
          </Title>
          <LineChart style={{ height: "16rem" }} dataset={dataset} noLegend={chart.length === 1}
            dimensions={[{ accessor: "qty", formatter: (v) => t("CONFIG_QTY_AXIS", fmt(Number(v))) }]}
            measures={chart.map((i) => ({
              accessor: `c${i}`, label: label(i), hideDataLabel: true, width: 2,
              // Keyed to the candidate, not the pick order, so unpicking one row never repaints
              // the others. ponytail: two picked rows 11 apart share a colour (the theme has 11);
              // the legend still tells them apart — map picks to free slots if that ever bites.
              color: `var(--sapChart_OrderedColor_${(i % 11) + 1})`,
              formatter: (v: number) => money(v, currency),
            }))} />
        </>
      ) : null}
    </div>
  );
}
