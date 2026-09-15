import { escapeLiteral, type CrossJoinSpec } from "@confire/b1";

// Exact help: latest Orders/Quotations for the configuration's item codes and/or its customer,
// fetched live through the B1 transport. Pure helpers here (testable); the oRPC handler in
// configs.ts calls crossJoin with what docHistoryQuery returns.
// B1's $filter parser has no lambda operators, so a document can't be filtered by its lines
// directly (all verified against b1s/v2, 400 code 201):
//   DocumentLines/any(d: d/ItemCode eq 'X')  -> "Invalid symbol in the filter condition"
//   DocumentLines/ItemCode eq 'X'            -> "Property 'DocumentLines/ItemCode' is invalid"
//   $expand=DocumentLines(...)               -> not a nav property (it's a complex collection)
// $crossjoin is the way in. It returns one flat {Entity, Entity/DocumentLines} pair per line,
// which is already DocRow's grain. The URL itself is built by packages/b1's crossJoinPath — this
// module only decides the shape, so its tests assert on data instead of on string equality.

export type DocRow = {
  docType: "order" | "quotation";
  /** the B1 key — what /b1/$entity/$key navigates by. */
  docEntry: number;
  docNum: number; docDate: string;
  /** the *document's* currency, not the model's: unitPrice is meaningless without it. */
  currency: string;
  cardCode: string; cardName: string;
  itemCode: string; itemDescription: string; quantity: number; unitPrice: number;
  matched: "both" | "customer" | "item";
};

export function docHistoryQuery(
  entity: "Orders" | "Quotations",
  opts: { itemCodes?: string[]; cardCode?: string; top?: number },
): CrossJoinSpec {
  const clauses: string[] = [];
  if (opts.cardCode) clauses.push(`${entity}/CardCode eq '${escapeLiteral(opts.cardCode)}'`);
  // n item codes, because the items grid is a list: one clause each, OR-ed into the same group the
  // customer clause sits in. The caller bounds n (the oRPC input caps it) — this only escapes.
  for (const code of opts.itemCodes ?? [])
    clauses.push(`${entity}/DocumentLines/ItemCode eq '${escapeLiteral(code)}'`);
  if (!clauses.length) throw new Error("docHistoryQuery needs an item code or a cardCode");
  // The DocEntry equality IS the join — without it the crossjoin pairs every document with every
  // line in the company. A customer-matched doc still pairs with all its lines (the header clause
  // holds for each), so the "keep all lines of my customer's docs" behaviour survives the rewrite.
  return {
    entities: [entity, `${entity}/DocumentLines`],
    expand: [
      { entity, select: ["DocEntry", "DocNum", "DocDate", "DocCurrency", "CardCode", "CardName"] },
      { entity: `${entity}/DocumentLines`, select: ["ItemCode", "ItemDescription", "Quantity", "UnitPrice"] },
    ],
    filter: `${entity}/DocEntry eq ${entity}/DocumentLines/DocEntry and (${clauses.join(" or ")})`,
    orderby: `${entity}/DocDate desc`,
    // ponytail: $top counts (doc,line) pairs now, not documents — fine, the pane lists rows.
    top: opts.top ?? 10,
  };
}

export function flattenDocs(
  docType: "order" | "quotation",
  json: unknown,
  opts: { itemCodes?: string[]; cardCode?: string },
): DocRow[] {
  const entity = docType === "order" ? "Orders" : "Quotations";
  const pairs = Array.isArray(json) ? json : ((json as { value?: unknown } | null)?.value ?? []);
  if (!Array.isArray(pairs)) return [];
  const out: DocRow[] = [];
  const wanted = new Set(opts.itemCodes ?? []);
  for (const p of pairs as Record<string, unknown>[]) {
    const d = (p[entity] ?? {}) as Record<string, unknown>;
    const l = (p[`${entity}/DocumentLines`] ?? {}) as Record<string, unknown>;
    const custMatch = !!opts.cardCode && d.CardCode === opts.cardCode;
    const itemMatch = typeof l.ItemCode === "string" && wanted.has(l.ItemCode);
    if (!itemMatch && !custMatch) continue; // B1 already filtered; this just guards `matched`
    out.push({
      docType,
      docEntry: Number(d.DocEntry ?? 0),
      docNum: Number(d.DocNum ?? 0), docDate: String(d.DocDate ?? ""),
      currency: String(d.DocCurrency ?? ""),
      cardCode: String(d.CardCode ?? ""), cardName: String(d.CardName ?? ""),
      itemCode: String(l.ItemCode ?? ""), itemDescription: String(l.ItemDescription ?? ""),
      quantity: Number(l.Quantity ?? 0), unitPrice: Number(l.UnitPrice ?? 0),
      matched: itemMatch && custMatch ? "both" : itemMatch ? "item" : "customer",
    });
  }
  return out;
}

/** Both-matches first, then newest first. */
export function sortDocRows(rows: DocRow[]): DocRow[] {
  return [...rows].sort(
    (a, b) => (a.matched === "both" ? 0 : 1) - (b.matched === "both" ? 0 : 1) || b.docDate.localeCompare(a.docDate),
  );
}
