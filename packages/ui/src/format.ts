import { decodeBool } from "@confire/b1";
import type { FieldType, Option } from "./types.ts";

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
      return d ? d.toLocaleDateString() : String(v);
    }
    case "number":
      return typeof v === "number" && !integer ? v.toLocaleString(undefined, { maximumFractionDigits: 6 }) : String(v);
    default:
      return typeof v === "object" ? JSON.stringify(v) : String(v);
  }
}
