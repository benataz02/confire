// Document copy: Quotation -> Order -> Delivery -> Invoice.
// Ported from b1-mcp-server's b1-document-service.ts (MIT): the flow table, the object-type codes
// and the line allowlist. B1 does the actual linking — a target line carrying
// {BaseType, BaseEntry, BaseLine} is what closes the source line and keeps the document flow
// intact. Everything else on the source line is either recalculated by B1 or must not be copied,
// which is why this is an allowlist and not a blocklist.

import { z } from "zod";
import type { EntityConstraints } from "./entity-meta.ts";

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
  if (!first) throw new Error("No source document");
  if (sources.some((s) => s.CardCode !== first.CardCode))
    throw new Error("Documents of different business partners cannot be merged into one");

  const all = sources.flatMap((source) => {
    const docEntry = Number(source.DocEntry);
    if (!Number.isFinite(docEntry)) throw new Error("Source document has no DocEntry");
    const sourceLines = Array.isArray(source.DocumentLines) ? (source.DocumentLines as Record<string, unknown>[]) : [];
    if (!sourceLines.length) throw new Error(`${flow.source} ${String(source.DocNum ?? docEntry)} has no lines`);
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
      if (!line) throw new Error(`Line ${o.baseLine} of document ${o.baseEntry} is not on a source document`);
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
