import type { RouterOutputs } from "../../orpc.ts";

export type Overview = RouterOutputs["dashboard"]["overview"];

export function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

/** Numeric string for AnalyticalCardHeader.value when unitOfMeasurement is "%". */
export function percentPoints(value: number | null): string {
  return value === null ? "—" : (value * 100).toFixed(1);
}

export function trendOf(current: number, previous: number): "Up" | "Down" | "None" {
  if (previous === 0) return "None";
  if (current > previous) return "Up";
  if (current < previous) return "Down";
  return "None";
}

export function deviationPct(current: number, previous: number): { number: string; unit: string } | null {
  if (previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  const sign = pct > 0 ? "+" : "";
  return { number: `${sign}${pct.toFixed(1)}`, unit: "%" };
}

/** AnalyticalCardHeader wants the number and its scaling prefix separately. */
export function scaled(value: number): { value: string; scale: string } {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return { value: (value / 1_000_000).toFixed(2), scale: "M" };
  if (abs >= 1_000) return { value: (value / 1_000).toFixed(1), scale: "k" };
  return { value: String(Math.round(value)), scale: "" };
}

export function greeting(now: Date, name: string): string {
  const h = now.getHours();
  const part = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
  return `Good ${part}, ${name}`;
}

export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y!, (m ?? 1) - 1, 1)).toLocaleDateString(undefined, {
    month: "short", timeZone: "UTC",
  });
}

export function conversionSlices(converted: number, quotes: number) {
  return [
    { status: "Converted", count: converted },
    { status: "Open", count: Math.max(quotes - converted, 0) },
  ];
}
