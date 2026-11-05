import type { B1Field } from "@confire/b1";
import type { ChartKind, FilterValue, Format } from "@confire/db";

// What a report run answers (reports spec §3.3): plain JSON, every figure computed by the server.
// The page draws it; a tile shows its first KPI; the chat gets a summary of it, never its rows.

export type KpiResult = {
  kind: "kpi"; title: string; format: Format;
  value: number | null; compare: number | null; deviation: number | null; target: number | null;
};
export type ChartResult = {
  kind: "chart"; title: string; note?: string; size: "wide" | "normal"; chart: ChartKind; dimension: string;
  rows: Record<string, string | number | null>[];
  measures: { key: string; label: string; format: Format; as?: "bar" | "line" | "area"; stackId?: string }[];
  target?: number;
};
export type TableResult = {
  kind: "table"; title: string; columns: string[]; groupBy: string[];
  rows: Record<string, unknown>[]; total: number | null; partial: boolean;
};
export type WidgetResult = KpiResult | ChartResult | TableResult;
/** One field of the report's filter bar, as the page draws it, and the value this run applied.
 *  `declared`: one of the definition's filters, shown; the others wait in Adapt Filters. */
export type BarFilter = {
  field: string; label: string; type: B1Field["kind"]; value: FilterValue; declared: boolean; default?: FilterValue;
  options?: B1Field["options"]; lookup?: B1Field["lookup"];
};
export type DatasetStat = { rows: number; partial: { read: number; total: number | null } | null; fellBack: boolean };
export type ReportResult = {
  readAt: string; company: string | null; currency: string | null;
  /** absent on a result stored before reports had a filter bar */
  filters?: BarFilter[];
  datasets: Record<string, DatasetStat>; widgets: WidgetResult[]; warnings: string[];
};
