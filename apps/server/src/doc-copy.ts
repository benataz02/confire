// Document copy: Quotation -> Order -> Delivery -> Invoice.
// Ported from b1-mcp-server's b1-document-service.ts (MIT): the flow table, the object-type codes
// and the line allowlist. B1 does the actual linking — a target line carrying
// {BaseType, BaseEntry, BaseLine} is what closes the source line and keeps the document flow
// intact. Everything else on the source line is either recalculated by B1 or must not be copied,
// which is why this is an allowlist and not a blocklist.

import { z } from "zod";
import type { EntityConstraints } from "./entity-meta.ts";
import { t } from "./i18n/index.ts";

export type DocumentFlow = {
  source: string;
  target: string;
  /** B1 object type of the SOURCE — that is what BaseType names. */
  baseType: number;
  label: string;
};

export const DOCUMENT_FLOWS: DocumentFlow[] = [
  { source: "Quotations", target: "Orders", baseType: 23, label: "Sales Quotation to Sales Order" },
  { source: "Orders", target: "DeliveryNotes", baseType: 17, label: "Sales Order to Delivery" },
  { source: "Orders", target: "Invoices", baseType: 17, label: "Sales Order to Invoice" },
  { source: "DeliveryNotes", target: "Invoices", baseType: 15, label: "Delivery to A/R Invoice" },
];

export const flowsFrom = (source: string): DocumentFlow[] => DOCUMENT_FLOWS.filter((f) => f.source === source);

export const findFlow = (source: string, target: string): DocumentFlow | undefined =>
  DOCUMENT_FLOWS.find((f) => f.source === source && f.target === target);

/** Safe business fields on a line. Excludes system-managed, calculated and accounting fields;
 *  every U_ UDF rides along, which is what keeps a tenant's own columns through a conversion. */
const LINE_FIELDS = new Set([
  "ItemCode", "ItemDescription", "Quantity", "Price", "UnitPrice", "Currency", "DiscountPercent",
  "WarehouseCode", "TaxCode", "TaxOnly", "CostingCode", "CostingCode2", "CostingCode3",
  "CostingCode4", "CostingCode5", "ProjectCode", "VatGroup", "UoMCode", "UoMEntry", "MeasureUnit",
  "UnitsOfMeasurment", "FreeText", "Text", "LineVendor",
]);

/** What a user may change on a copy's draft page before it is posted: these header fields, and per
 *  line its quantity (a partial delivery or invoice) — or drop the line. Everything else is the
 *  source's. The zod schema is the list: `draftConstraints` derives the form's Editable from it. */
export const CopyHeaderZ = z.object({
  DocDate: z.string(),
  DocDueDate: z.string(),
  NumAtCard: z.string().max(100),
  Comments: z.string().max(254),
}).partial().strict();
export type CopyHeader = z.infer<typeof CopyHeaderZ>;
const COPY_HEADER = Object.keys(CopyHeaderZ.shape) as (keyof CopyHeader)[];

/** A kept line, named by the source line it copies. */
export type CopyLine = { baseEntry: number; baseLine: number; quantity: number };

/** The target's constraints as the draft page's form: read-only but for the copy's own allowlist,
 *  and lines required, so a draft emptied of lines is refused rather than posting every line. */
export function draftConstraints(c: EntityConstraints): EntityConstraints {
  const fields = { ...c.fields };
  for (const k of COPY_HEADER) if (fields[k]) fields[k] = { ...fields[k], Editable: true };
  const lines = fields.DocumentLines;
  if (lines?.Fields?.Quantity) fields.DocumentLines = {
    ...lines, Editable: true, Required: true,
    Fields: { ...lines.Fields, Quantity: { ...lines.Fields.Quantity, Editable: true } },
  };
  return { ...c, writable: false, fields };
}

export type SourceDocument = {
  DocEntry?: unknown;
  DocNum?: unknown;
  CardCode?: unknown;
  CardName?: unknown;
  DocDate?: unknown;
  DocDueDate?: unknown;
  DocumentLines?: unknown;
};

/**
 * Build the target document from source documents read out of B1. Several sources merge into one
 * target — B1's own "Copy From" with many base documents — which needs one business partner.
 */
export function buildCopy(
  flow: DocumentFlow,
  sources: SourceDocument[],
  /** the draft's changes; `lines` absent keeps every line as the source has it */
  opts: { header?: CopyHeader; lines?: CopyLine[] } = {},
): Record<string, unknown> {
  const first = sources[0];
  if (!first) throw new Error(t("COPY_NO_SOURCE"));
  if (sources.some((s) => s.CardCode !== first.CardCode))
    throw new Error(t("COPY_MIXED_PARTNERS"));

  const all = sources.flatMap((source) => {
    const docEntry = Number(source.DocEntry);
    if (!Number.isFinite(docEntry)) throw new Error(t("COPY_NO_DOCENTRY"));
    const sourceLines = Array.isArray(source.DocumentLines) ? (source.DocumentLines as Record<string, unknown>[]) : [];
    if (!sourceLines.length) throw new Error(t("COPY_NO_LINES", flow.source, String(source.DocNum ?? docEntry)));
    return sourceLines.map((src, i) => {
      // BaseLine is the source line's LineNum, not its array position — they diverge as soon as a
      // line is deleted from the source document.
      const baseLine = Number(src.LineNum ?? i);
      const line: Record<string, unknown> = { BaseType: flow.baseType, BaseEntry: docEntry, BaseLine: baseLine };
      for (const [k, v] of Object.entries(src)) {
        if (v === null || v === undefined) continue;
        if (LINE_FIELDS.has(k) || k.startsWith("U_")) line[k] = v;
      }
      return line;
    });
  });

  let DocumentLines = all;
  if (opts.lines) {
    const byBase = new Map(all.map((l) => [`${String(l.BaseEntry)}:${String(l.BaseLine)}`, l]));
    DocumentLines = opts.lines.map((o) => {
      const line = byBase.get(`${o.baseEntry}:${o.baseLine}`);
      if (!line) throw new Error(t("COPY_LINE_NOT_ON_SOURCE", o.baseLine, o.baseEntry));
      return { ...line, Quantity: o.quantity };
    });
  }

  const nums = sources.map((s) => String(s.DocNum ?? s.DocEntry)).join(", ");
  return {
    CardCode: first.CardCode,
    ...(first.CardName ? { CardName: first.CardName } : {}),
    // A merge takes its dates from the first source.
    ...(first.DocDate ? { DocDate: first.DocDate } : {}),
    ...(first.DocDueDate ? { DocDueDate: first.DocDueDate } : {}),
    // Comments is nvarchar(254) in B1.
    Comments: `Created from ${flow.source} ${nums} in Confire`.slice(0, 254),
    ...CopyHeaderZ.parse(opts.header ?? {}),
    DocumentLines,
  };
}

/** Fields the copy needs off the source; keeps the read narrow. */
export const COPY_SELECT = ["DocEntry", "DocNum", "CardCode", "CardName", "DocDate", "DocDueDate", "DocumentLines"];

// --- configured parts ------------------------------------------------------------------------------
// A part with no SAP item is quoted on the model's generic item with its code in ITEM_UDF
// (config-quote.ts). An order needs the real item, and B1 will not put another item on a line linked
// to its base, so a Quotations→Orders copy first makes each one real: create the item as a duplicate
// of the generic one, put it on the quotation's line, then copy the quotation as it now is.

/** The line UDF carrying a configured part's code (the items grid's default map, config-engine). */
export const ITEM_UDF = "U_CF_ItemCode";

/** A source line quoted on a generic item for a part; `item` is the item it goes on. */
export type PartLine = { docEntry: number; lineNum: number; code: string; generic: string; name: string };

const linesOf = (s: SourceDocument) => (Array.isArray(s.DocumentLines) ? (s.DocumentLines as Record<string, unknown>[]) : []);

/** The open lines of the sources still on a generic item — ITEM_UDF holds a code that is not the
 *  line's ItemCode (case-blind, as SQL Server matches) — of the kept lines only, when `kept` is set. */
export function partLines(sources: SourceDocument[], kept?: CopyLine[]): PartLine[] {
  const keep = kept && new Set(kept.map((l) => `${l.baseEntry}:${l.baseLine}`));
  return sources.flatMap((s) => linesOf(s).flatMap((l, i) => {
    const docEntry = Number(s.DocEntry);
    const lineNum = Number(l.LineNum ?? i);
    const code = typeof l[ITEM_UDF] === "string" ? (l[ITEM_UDF] as string).trim() : "";
    const generic = typeof l.ItemCode === "string" ? l.ItemCode : "";
    if (!code || code.toUpperCase() === generic.toUpperCase() || l.LineStatus === "bost_Close") return [];
    if (keep && !keep.has(`${docEntry}:${lineNum}`)) return [];
    const name = typeof l.ItemDescription === "string" && l.ItemDescription ? l.ItemDescription : code;
    return [{ docEntry, lineNum, code, generic, name }];
  }));
}

/** The sources as they will be once each part line is on its item. */
export function onItems(sources: SourceDocument[], parts: (PartLine & { item: string })[]): SourceDocument[] {
  const at = new Map(parts.map((p) => [`${p.docEntry}:${p.lineNum}`, p.item]));
  return sources.map((s) => Array.isArray(s.DocumentLines) ? {
    ...s,
    DocumentLines: linesOf(s).map((l, i) => {
      const item = at.get(`${Number(s.DocEntry)}:${Number(l.LineNum ?? i)}`);
      return item ? { ...l, ItemCode: item } : l;
    }),
  } : s);
}

/** What B1 keeps for itself on an item: stock, cost, dates, the numbering series — and barcodes,
 *  which are one item's each. Everything else is the duplicate's, as SAP's own Duplicate keeps it. */
const ITEM_OWN = new Set([
  "ItemCode", "ItemName", "BarCode", "ItemBarCodeCollection", "Series", "QuantityOnStock",
  "QuantityOrderedFromVendors", "QuantityOrderedByCustomers", "MovingAveragePrice", "AvgStdPrice",
  "CreateDate", "CreateTime", "UpdateDate", "UpdateTime", "DataVersion",
]);
const WAREHOUSE_OWN = new Set(["InStock", "Committed", "Ordered", "CountedQuantity", "WasCounted", "Counted", "StandardAveragePrice", "UserSignature"]);

const present = (o: Record<string, unknown>, drop: Set<string>) =>
  Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== null && v !== undefined && !k.startsWith("@") && !drop.has(k)));

/** A new item as a duplicate of `generic` (the item read whole): only the code and the name differ.
 *  ponytail: unverified (spec §16) — the field list was read off a live Items GET, not yet posted
 *  back; a field B1 refuses on create comes back as its own error and joins ITEM_OWN. Also that B1
 *  keeps the sent ItemCode when the default item series is not Manual. */
export function duplicateItem(generic: Record<string, unknown>, code: string, name: string): Record<string, unknown> {
  const item = present(generic, ITEM_OWN);
  if (Array.isArray(item.ItemWarehouseInfoCollection))
    item.ItemWarehouseInfoCollection = (item.ItemWarehouseInfoCollection as Record<string, unknown>[]).map((w) => present(w, WAREHOUSE_OWN));
  return { ItemCode: code, ItemName: name, ...item };
}

/** A line's own figures, sent back with its new item: B1 re-prices and renames a line whose item
 *  changes, and the quotation must still say what the customer was quoted. Price follows from
 *  UnitPrice and DiscountPercent. ponytail: unverified (spec §16) — that this list is all a live B1
 *  resets on an item change. */
const KEEP_ON_SWAP = [
  "Quantity", "UnitPrice", "DiscountPercent", "Currency", "ItemDescription", "WarehouseCode", "TaxCode", "VatGroup",
  "ProjectCode", "CostingCode", "CostingCode2", "CostingCode3", "CostingCode4", "CostingCode5",
];

/** A quotation line put on `item`, for a PATCH that merges lines by LineNum. */
export function swapLine(line: Record<string, unknown>, item: string): Record<string, unknown> {
  const out: Record<string, unknown> = { LineNum: line.LineNum, ItemCode: item };
  for (const k of KEEP_ON_SWAP) if (line[k] !== null && line[k] !== undefined) out[k] = line[k];
  return out;
}
