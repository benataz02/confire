import type { Facet, ValueState } from "./types.ts";

/** B1's BoStatus member names (what the Service Layer sends) -> a status colour. Both apps' document
 *  pages read it. `text` stays the English id; a display site passes `t` to documentStatusText. */
export const DOCUMENT_STATUS: Facet["statusMapping"] = {
  bost_Open: { state: "Information", text: "Open" },
  bost_Close: { state: "None", text: "Closed" },
  bost_Paid: { state: "Positive", text: "Paid" },
  bost_Delivered: { state: "Positive", text: "Delivered" },
};

/** A status field's colour; a code the map does not know reads uncoloured. */
export const statusState = (code: unknown): ValueState => DOCUMENT_STATUS?.[String(code ?? "")]?.state ?? "None";

const DOCUMENT_STATUS_KEY: Record<string, string> = {
  bost_Open: "UI_STATUS_OPEN",
  bost_Close: "UI_STATUS_CLOSED",
  bost_Paid: "UI_STATUS_PAID",
  bost_Delivered: "UI_STATUS_DELIVERED",
};

/** The label a reader sees. Without `t`, `fallback` (the map's English text, or the raw code). */
export function documentStatusText(
  code: string,
  fallback: string | undefined,
  t?: (key: string, ...params: Array<string | number>) => string,
): string {
  const key = DOCUMENT_STATUS_KEY[code];
  return key && t ? t(key) : (fallback ?? code);
}
