import { z } from "zod";
import type { B1EntitySchema, B1Field } from "@confire/b1";
import type { PortalDocFields } from "@confire/db";

// What a portal client may see of a SAP document (spec §13.1, D19): the tenant's admin picks the
// fields, and this module decides what that pick can mean. It is applied on every read, not only
// when the setting is saved, so a stale setting can never expose a field later added to the
// denylist or a UDF that no longer exists. Pure: both processes import it.

export const DOC_ENTITIES = ["Quotations", "Orders", "DeliveryNotes", "Invoices"] as const;
export type DocEntity = (typeof DOC_ENTITIES)[number];
export const DocEntityZ = z.enum(DOC_ENTITIES);

/** In every portal schema and never offered: the page header needs them, and the timeline already
 *  shows total and status to the client. */
export const ALWAYS = ["DocEntry", "DocNum", "DocDate", "DocumentStatus", "DocTotal", "DocCurrency"];
/** The fence field (§13): a list appends `CardCode eq …` after compiling, so it is never a column. */
export const NEVER = ["CardCode"];
/** An entity with no setting shows these, the internal lists' own columns. Not Comments: B1's
 *  Remarks often hold internal notes, so an admin opts it in. */
export const DOC_DEFAULTS: PortalDocFields = {
  header: ["DocDueDate", "NumAtCard"],
  lines: ["ItemCode", "ItemDescription", "Quantity", "UnitPrice", "LineTotal"],
};

/** Cost, profit, margins, purchase prices and commissions: no setting can expose them. Header and
 *  line fields alike, matched case-insensitively. Checked against a live tenant's cached schemas:
 *  `Stock*` is the row's inventory value (StockPrice, StockSum*, StockInmPrice, StockDistributesum*),
 *  `LastBuy*` the last purchase price, `*Profit*` covers OperatingProfit* and ServiceGrossProfitPercent,
 *  `Commis*` B1's own spelling (CommisionPercent). Not a bare /inm/: it would hit U_SII_SINMUEBLE. */
const DENYLIST = [/cost/i, /profit/i, /^grossbuyprice$/i, /^stock/i, /^lastbuy/i, /margin/i, /commis/i, /^u_cf_key$/i];

export const isDenied = (name: string): boolean => DENYLIST.some((re) => re.test(name));

const LINES = "DocumentLines";
const blocked = new Set([...ALWAYS, ...NEVER]);

/** `names` in their order, as fields of `from`: scalars only, nothing blocked or denied, no repeats. */
function pick(from: B1Field[], names: string[], skip: Set<string>): B1Field[] {
  const byName = new Map(from.map((f) => [f.name, f]));
  const out = new Map<string, B1Field>();
  for (const n of names) {
    const f = byName.get(n);
    if (f && f.kind !== "collection" && !skip.has(n) && !isDenied(n)) out.set(n, f);
  }
  return [...out.values()];
}

/** The cached B1 schema cut down to what this tenant shows its clients: ALWAYS, then the header
 *  list, then `DocumentLines` holding the line list — in setting order, so the list's columns and
 *  the form follow the admin's. No line fields, no collection. */
export function portalSchema(schema: B1EntitySchema, fields: PortalDocFields | undefined): B1EntitySchema {
  const { header, lines } = fields ?? DOC_DEFAULTS;
  const always = ALWAYS.flatMap((n) => schema.fields.filter((f) => f.name === n));
  const coll = schema.fields.find((f) => f.name === LINES && f.kind === "collection");
  const lineFields = pick(coll?.fields ?? [], lines, new Set());
  return {
    ...schema,
    fields: [
      ...always,
      ...pick(schema.fields, header, blocked),
      ...(coll && lineFields.length ? [{ ...coll, fields: lineFields }] : []),
    ],
  };
}

/** What the settings picker offers: scalar header fields and DocumentLines fields an admin may add. */
export function pickable(schema: B1EntitySchema): { header: B1Field[]; lines: B1Field[] } {
  const coll = schema.fields.find((f) => f.name === LINES && f.kind === "collection");
  return {
    header: pick(schema.fields, schema.fields.map((f) => f.name), blocked),
    lines: pick(coll?.fields ?? [], (coll?.fields ?? []).map((f) => f.name), new Set()),
  };
}

/** One row cut to a portal schema, each line to its line fields. The read's `$select` already
 *  asks for no more, but this does not depend on it: B1 adds `odata.*` and a cursor page can
 *  outlive a setting. */
export function projectRow(schema: B1EntitySchema, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of schema.fields) {
    if (!(f.name in row)) continue;
    const v = row[f.name];
    if (f.kind === "collection") {
      const keep = (f.fields ?? []).map((x) => x.name);
      out[f.name] = Array.isArray(v)
        ? v.map((l) => Object.fromEntries(keep.filter((k) => k in (l as object)).map((k) => [k, (l as Record<string, unknown>)[k]])))
        : [];
    } else out[f.name] = v;
  }
  return out;
}
