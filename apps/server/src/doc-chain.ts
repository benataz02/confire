import type { B1Transport, CrossJoinSpec } from "@confire/b1";

// The forward document walk: from the quotation Confire wrote (config_project.b1DocEntry — the only B1
// link Confire stores) to whatever SAP has since made of it.
//
// $crossjoin, not $expand: B1's $filter has no lambda operators, so a document cannot be filtered
// by its lines directly. All three alternatives were tried against b1s/v2 and all three 400 with
// code 201 — keep this list, it is the reason the join is written by hand:
//   DocumentLines/any(d: d/ItemCode eq 'X')  -> "Invalid symbol in the filter condition"
//   DocumentLines/ItemCode eq 'X'            -> "Property 'DocumentLines/ItemCode' is invalid"
//   $expand=DocumentLines(...)               -> not a nav property (it's a complex collection)
// The DocEntry equality below IS the join; without it the crossjoin pairs every document with
// every line in the company.
//
// The BaseType codes are DOCUMENT_FLOWS' (doc-copy.ts) — the same table the forward copy writes,
// so the walk and the write agree by construction:
//   Quotation(23) -> Orders     Order(17) -> DeliveryNotes, Invoices     Delivery(15) -> Invoices

export type ChainEntity = "Quotations" | "Orders" | "DeliveryNotes" | "Invoices";

export type ChainDoc = {
  entity: ChainEntity;
  docEntry: number;
  docNum: number;
  docDate: string;
  docTotal: number;
  docStatus: string;
  /** the portal's fence: a client sees a document only when it is theirs (spec §8) */
  cardCode: string;
};

const SELECT = ["DocEntry", "DocNum", "DocDate", "DocTotal", "DocumentStatus", "CardCode"];

/** `lines/BaseType eq T and (lines/BaseEntry eq a or lines/BaseEntry eq b …)` — B1's $filter has
 *  no `in` operator either, so a set of parents is an OR group. */
export function baseClause(entity: string, baseType: number, baseEntries: number[]): string {
  const ors = baseEntries.map((e) => `${entity}/DocumentLines/BaseEntry eq ${e}`).join(" or ");
  return `${entity}/DocumentLines/BaseType eq ${baseType} and (${ors})`;
}

/** One hop. The DocEntry equality IS the join — without it the crossjoin pairs every document
 *  with every line in the company. */
export function chainQuery(entity: ChainEntity, clauses: string[], top = 50): CrossJoinSpec {
  return {
    entities: [entity, `${entity}/DocumentLines`],
    expand: [
      { entity, select: SELECT },
      { entity: `${entity}/DocumentLines`, select: ["BaseType", "BaseEntry"] },
    ],
    filter: `${entity}/DocEntry eq ${entity}/DocumentLines/DocEntry and (${clauses.join(" or ")})`,
    orderby: `${entity}/DocDate desc`,
    // ponytail: $top counts (doc, line) pairs, not documents. A quotation copied into more than
    //           ~50 order lines would truncate; raise it then.
    top,
  };
}

/** Crossjoin pairs -> documents, deduped by DocEntry (one pair per matching line). */
export function flattenChain(entity: ChainEntity, json: unknown): ChainDoc[] {
  const pairs = Array.isArray(json) ? json : ((json as { value?: unknown } | null)?.value ?? []);
  if (!Array.isArray(pairs)) return [];
  const seen = new Map<number, ChainDoc>();
  for (const p of pairs as Record<string, unknown>[]) {
    const d = (p[entity] ?? {}) as Record<string, unknown>;
    const docEntry = Number(d.DocEntry ?? 0);
    if (!docEntry || seen.has(docEntry)) continue;
    seen.set(docEntry, {
      entity,
      docEntry,
      docNum: Number(d.DocNum ?? 0),
      docDate: String(d.DocDate ?? ""),
      docTotal: Number(d.DocTotal ?? 0),
      docStatus: String(d.DocumentStatus ?? ""),
      cardCode: String(d.CardCode ?? ""),
    });
  }
  return [...seen.values()];
}

export type DocRef = { entity: ChainEntity; docEntry: number };

// Base document type → the entity it names, the walk back (the codes the forward walk above filters on).
const BASE: Record<number, ChainEntity> = { 23: "Quotations", 17: "Orders", 15: "DeliveryNotes" };

/**
 * The quotations documents descend from, walking back through their lines' BaseType/BaseEntry —
 * invoice → delivery → order → quotation at most. Unfenced: `readFirst` reads the starting documents
 * instead of a plain read when the caller fences them (the portal's CardCode check, which then runs
 * on a quotation too). The callers wrap it in viaB1.
 * ponytail: at most 50 documents per hop (a copy's own cap, CopyZ) — raise it if one document ever
 * gathers more base documents.
 */
export async function quotationsBehind(
  b1: B1Transport, from: DocRef[], readFirst?: (d: DocRef) => Promise<Record<string, unknown>>,
): Promise<number[]> {
  const found = new Set<number>();
  let frontier = from;
  for (let hop = 0; hop < 4 && frontier.length; hop++) {
    const next = new Map<string, DocRef>();
    for (const d of frontier.slice(0, 50)) {
      const fenced = hop === 0 && readFirst;
      if (d.entity === "Quotations" && !fenced) { found.add(d.docEntry); continue; }
      const row = fenced ? await readFirst(d)
        : (await b1.readEntity(d.entity, d.docEntry, { select: ["DocumentLines"] })).data as Record<string, unknown>;
      if (d.entity === "Quotations") { found.add(d.docEntry); continue; }
      for (const l of (row.DocumentLines as Record<string, unknown>[] | undefined) ?? []) {
        const base = BASE[Number(l.BaseType)];
        const entry = Number(l.BaseEntry);
        if (base && Number.isInteger(entry) && entry > 0) next.set(`${base}:${entry}`, { entity: base, docEntry: entry });
      }
    }
    frontier = [...next.values()];
  }
  return [...found];
}

/**
 * The whole chain for one quotation, oldest hop first. Three sequential crossjoins: each hop
 * needs the previous hop's DocEntries to filter on, so they cannot be parallelised.
 * A hop whose source set is empty is skipped entirely rather than sent as `BaseEntry eq ()`.
 *
 * // ponytail: 3 sequential crossjoins per open project; cache the result on config_project if it
 * //           ever shows up in a trace.
 */
export async function documentChain(b1: B1Transport, quotationDocEntry: number): Promise<ChainDoc[]> {
  const hop = async (entity: ChainEntity, clauses: string[]) =>
    clauses.length ? flattenChain(entity, (await b1.crossJoin(chainQuery(entity, clauses))).data) : [];

  const orders = await hop("Orders", [baseClause("Orders", 23, [quotationDocEntry])]);
  const orderEntries = orders.map((o) => o.docEntry);

  const deliveries = await hop("DeliveryNotes", orderEntries.length ? [baseClause("DeliveryNotes", 17, orderEntries)] : []);
  const deliveryEntries = deliveries.map((d) => d.docEntry);

  // An invoice can be raised straight from the order OR from the delivery — both, in one read.
  const invoices = await hop("Invoices", [
    ...(orderEntries.length ? [baseClause("Invoices", 17, orderEntries)] : []),
    ...(deliveryEntries.length ? [baseClause("Invoices", 15, deliveryEntries)] : []),
  ]);

  return [...orders, ...deliveries, ...invoices];
}
