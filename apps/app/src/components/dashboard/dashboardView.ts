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

type Text = (key: string, ...params: string[]) => string;

export function greeting(now: Date, name: string, t: Text): string {
  const h = now.getHours();
  const key = h < 12 ? "SHELL_DASH_GREETING_MORNING" : h < 18 ? "SHELL_DASH_GREETING_AFTERNOON" : "SHELL_DASH_GREETING_EVENING";
  return t(key, name);
}

/** `locale` is the UI5 language (`en` / `es`). `undefined` follows the browser. */
export function monthLabel(ym: string, locale?: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y!, (m ?? 1) - 1, 1)).toLocaleDateString(locale, {
    month: "short", timeZone: "UTC",
  });
}

export function conversionSlices(converted: number, quotes: number, t: Text) {
  return [
    { status: t("SHELL_DASH_CONVERTED"), count: converted },
    { status: t("SHELL_DASH_OPEN"), count: Math.max(quotes - converted, 0) },
  ];
}

const STAGE_KEY: Record<string, string> = {
  Draft: "SHELL_DASH_STAGE_DRAFT",
  Quoted: "SHELL_DASH_STAGE_QUOTED",
  Ordered: "SHELL_DASH_STAGE_ORDERED",
};

export function stageLabel(stage: string, t: Text): string {
  const key = STAGE_KEY[stage];
  return key ? t(key) : stage;
}

const BUCKET_KEY: Record<string, string> = {
  "0-7d": "SHELL_DASH_BUCKET_0_7",
  "8-14d": "SHELL_DASH_BUCKET_8_14",
  "15-30d": "SHELL_DASH_BUCKET_15_30",
  "30d+": "SHELL_DASH_BUCKET_30_PLUS",
};

export function bucketLabel(bucket: string, t: Text): string {
  const key = BUCKET_KEY[bucket];
  return key ? t(key) : bucket;
}

/** The stale-quote sentence is the only reason this view knows. Anything else (a portal
 *  reason the server phrases itself) is already a sentence and passes through. */
export function attentionReason(reason: string, t: Text): string {
  const days = /^No movement for (\d+)\+ days$/.exec(reason)?.[1];
  return days ? t("SHELL_DASH_STALE_REASON", days) : reason;
}
