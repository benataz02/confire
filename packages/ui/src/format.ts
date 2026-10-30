import getLocale from "@ui5/webcomponents-base/dist/locale/getLocale.js";
import { decodeBool } from "@confire/b1";
import type { FieldType, Option } from "./types.ts";

/** The locale every number and date is drawn in: the UI language — UI5's, so the user menu's choice
 *  or `?sap-ui-language`, else the browser's — the same one UI5's own date pickers use. The browser's
 *  region stays when its language agrees, so English on an en-GB browser still reads 24/10/2026.
 *  Never the browser locale alone (`undefined`): that drew "1,234.50" beside Spanish texts and
 *  ignored a language switch. Display only — B1 and the API always get ISO dates and plain numbers. */
export function formatLocale(): string {
  const ui = getLocale().toString();
  const browser = typeof navigator === "undefined" ? undefined : navigator.languages?.[0] ?? navigator.language;
  return browser && browser.split("-")[0] === ui.split("-")[0] ? browser : ui;
}

// Beas `Uc`, the column type table: how a value of each type reads in a cell, a facet, a display
// field and the .xlsx export.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** The local calendar day of an ISO date. Read off the string rather than through
 *  `new Date(v)`: that parses B1's "…T00:00:00Z" as UTC midnight, which is the *previous* day
 *  anywhere west of Greenwich. */
export function parseIsoDate(v: unknown): Date | null {
  const iso = ISO_DATE.exec(String(v ?? ""));
  if (iso) return new Date(+iso[1]!, +iso[2]! - 1, +iso[3]!);
  const d = new Date(v as string | number | Date);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A Date as the yyyy-MM-dd B1 and the date pickers speak, in local time. */
export const toIsoDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const isNumericType = (t: FieldType | undefined) => t === "number";
/** Numbers and dates end-align in a grid (Uc's `align: 'end'`). */
export const endAligned = (t: FieldType | undefined) => t === "number" || t === "date" || t === "time";

export function optionLabel(v: unknown, options: Option[] | undefined): string | undefined {
  return options?.find((o) => o.value === v || String(o.value) === String(v))?.label;
}

/** One value as text: option label, then by type — ✓/– for booleans, the local date for dates
 *  (the time half of a B1 date is always midnight and never meaningful), grouped digits for
 *  numbers — except an `integer` one: in B1 that is a key, a document number or a code, and
 *  DocNum "1,234" reads as a quantity. */
export function formatValue(v: unknown, type?: FieldType, options?: Option[], integer?: boolean): string {
  if (v === null || v === undefined || v === "") return "";
  const label = optionLabel(v, options);
  if (label !== undefined) return label;
  switch (type) {
    case "boolean":
      return decodeBool(v) ? "✓" : "–";
    case "date": {
      const d = parseIsoDate(v);
      return d ? d.toLocaleDateString(formatLocale()) : String(v);
    }
    case "number":
      return typeof v === "number" && !integer ? v.toLocaleString(formatLocale(), { maximumFractionDigits: 6 }) : String(v);
    default:
      return typeof v === "object" ? JSON.stringify(v) : String(v);
  }
}

/** A person's avatar initials: the first letter of their first two words ("Ana María López" → "AM"). */
export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60],
];
/** "5 minutes ago", in the page's UI5 language. */
export function ago(d: Date): string {
  const s = (new Date(d).getTime() - Date.now()) / 1000;
  const f = new Intl.RelativeTimeFormat(formatLocale(), { numeric: "auto" });
  const unit = UNITS.find(([, n]) => Math.abs(s) >= n);
  return unit ? f.format(Math.round(s / unit[1]), unit[0]) : f.format(0, "minute");
}
