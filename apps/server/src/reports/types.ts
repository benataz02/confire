import type { ChartKind, Format } from "@confire/db";

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
export type DatasetStat = { rows: number; partial: { read: number; total: number | null } | null; fellBack: boolean };
export type ReportResult = {
  readAt: string; company: string | null; currency: string | null;
  datasets: Record<string, DatasetStat>; widgets: WidgetResult[]; warnings: string[];
};
