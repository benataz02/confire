import {
  evalTableRows, paramPrices, refKeyCols,
  type Entries, type LookupRef, type ModelDef, type Param, type Propagation, type ResolvedLookups, type ResolvedTable,
  type TableDef, type TableRows, type Val,
} from "@confire/config-engine";
import type { ConfigCandidate, PortalPrice } from "@confire/db";
import { sameJson } from "../canon.ts";

// What the portal configurator receives (spec §7.1). The engine runs on the server; the client gets
// a projection of the model, the propagation and the lookups — enough to draw the form, nothing to
// price with. This module IS the fence, so each function names what it keeps rather than what it
// drops: a field added to ModelDef later stays home until someone adds it here.

/** A parameter's display shape. Every expression stays home — defaults, visibility, requiredness
 *  and prices are the server's, and arrive evaluated in toPortalProp. */
function portalParam(p: Param): Param {
  const { key, label, type, ui, domain, mandatory, readonly, excludeFromDomains, unit, help } = p;
  return {
    key, label, type, ui,
    ...(domain ? { domain } : {}),
    ...(mandatory ? { mandatory } : {}),
    ...(readonly ? { readonly } : {}),
    ...(excludeFromDomains ? { excludeFromDomains } : {}),
    ...(unit ? { unit } : {}),
    ...(help ? { help } : {}),
  };
}

/** A table's display shape: formula expressions blanked (the values arrive evaluated), and the
 *  items grid without its cost basis and its SAP field map. The runtime unitcost/unitprice columns
 *  are not declared columns, so there is nothing of them to drop here. */
function portalTable(t: TableDef): TableDef {
  const columns = t.columns.map((c) => (c.cell.kind === "formula" ? { ...c, cell: { kind: "formula" as const, expr: "" } } : c));
  return t.role === "items"
    ? { key: t.key, title: t.title, role: "items", columns, basisExpr: "" }
    : { key: t.key, title: t.title, role: "calc", columns,
        ...(t.minRows === undefined ? {} : { minRows: t.minRows }), ...(t.maxRows === undefined ? {} : { maxRows: t.maxRows }) };
}

/** name, description, parameters (display shape), structure, tables (display shape). computed,
 *  constraints, bom, routing, history and pricing stay out. */
export function toPortalModelDef(model: ModelDef): ModelDef {
  return {
    name: model.name,
    ...(model.description ? { description: model.description } : {}),
    parameters: model.parameters.map(portalParam),
    structure: model.structure,
    ...(model.tables ? { tables: model.tables.map(portalTable) } : {}),
    computed: [], constraints: [], bom: [], routing: [],
    pricing: { priceExpr: "", quoteItemCode: "" },
    batchDefaults: [],
  };
}

export type PortalProp = Propagation & {
  /** each table's rows, evaluated here — how a formula cell shows a value without its expression */
  tables: Record<string, Record<string, Val>[]>;
};

/** The propagation, parameter keys only (values: visible ones): no computed values, no `<param>_<column>` derived keys —
 *  those can carry any column of a masterdata row, hidden ones included. `conflicts` are the
 *  author's own messages. The tables arrive evaluated, declared columns only (a typed unit price
 *  is not a declared column). */
export function toPortalProp(model: ModelDef, prop: Propagation, lookups: ResolvedLookups, tableRows: TableRows): PortalProp {
  const keys = new Set(model.parameters.map((p) => p.key));
  const pick = <T,>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).filter(([k]) => keys.has(k)));
  return {
    // A parameter the rules hide is not drawn, so its value has nowhere to go but the wire.
    values: Object.fromEntries(Object.entries(prop.values).filter(([k]) => keys.has(k) && prop.visible[k])),
    defaulted: new Set([...prop.defaulted].filter((k) => keys.has(k))),
    visible: pick(prop.visible),
    required: pick(prop.required),
    domains: pick(prop.domains),
    conflicts: prop.conflicts,
    open: prop.open.filter((k) => keys.has(k)),
    candidateEstimate: 0,
    tables: Object.fromEntries((model.tables ?? []).map((t) => {
      const cols = t.columns.map((c) => c.key);
      const rows = evalTableRows(t, tableRows[t.key] ?? [], prop.values, lookups.tables);
      return [t.key, rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])))];
    })),
  };
}

/** A table as the portal may see it: the non-`hidden` columns, plus the key and label columns the
 *  form looks rows up by even if the author hid them — dropping the key would break the picker. */
function portalTableData(t: ResolvedTable, refs: LookupRef[]): ResolvedTable {
  const hidden = new Set(t.hidden ?? []);
  const needed = new Set(refs.flatMap((r) => { const k = refKeyCols(r, t.columns); return [k.valueCol, k.labelCol ?? ""]; }));
  const idx = t.columns.flatMap((c, i) => (!hidden.has(c) || needed.has(c) ? [i] : []));
  const columns = idx.map((i) => t.columns[i]!);
  const labels = t.labels ? Object.fromEntries(Object.entries(t.labels).filter(([c]) => columns.includes(c))) : undefined;
  return {
    columns,
    rows: t.rows.map((r) => idx.map((i) => r[i] ?? null)),
    ...(t.nextSkip === undefined ? {} : { nextSkip: t.nextSkip }),
    ...(labels ? { labels } : {}),
  };
}

/** The option tables a visible parameter or a table column names, and only their non-hidden
 *  columns; the domains of the visible parameters. `prices` never goes. */
export function toPortalLookups(model: ModelDef, prop: Propagation, lookups: ResolvedLookups): ResolvedLookups {
  const refs = new Map<string, LookupRef[]>();
  const add = (r: LookupRef) => { if (r.source !== "manual") refs.set(r.table, [...(refs.get(r.table) ?? []), r]); };
  for (const p of model.parameters) if (prop.visible[p.key] && p.domain?.kind === "options") add(p.domain.ref);
  for (const t of model.tables ?? []) for (const c of t.columns) if (c.cell.kind === "options") add(c.cell.ref);
  const tables: Record<string, ResolvedTable> = {};
  for (const [name, rs] of refs) {
    const t = lookups.tables[name];
    if (t) tables[name] = portalTableData(t, rs);
  }
  const visible = new Set(model.parameters.filter((p) => prop.visible[p.key]).map((p) => p.key));
  return { domains: Object.fromEntries(Object.entries(lookups.domains).filter(([k]) => visible.has(k))), tables };
}

/** Indicative figures per batch quantity, from the current candidates: one candidate is exact,
 *  several give the cheapest as "from". Only these numbers leave — never an item split. */
export function toPortalPrices(candidates: ConfigCandidate[], batches: number[]): PortalPrice[] {
  return batches.flatMap((batchQty) => {
    const outs = candidates.flatMap((c) => c.perBatch.filter((b) => b.batchQty === batchQty).map((b) => b.outputs));
    if (!outs.length) return [];
    const best = outs.reduce((a, b) => (b.unitPrice < a.unitPrice ? b : a));
    return [{ batchQty, unitPrice: best.unitPrice, total: best.batchTotal, from: outs.length > 1 }];
  });
}

/** The per-option price badges, as amounts: the expression never leaves the server. */
export const toPortalBadges = (model: ModelDef, prop: Propagation, lookups: ResolvedLookups): Record<string, number> =>
  Object.fromEntries(paramPrices(model, prop, lookups.tables).map((c) => [c.key, c.amount]));

/** A table query page as the portal may see it (the value help): the same column rule as the
 *  canonical tables, against every ref of the model that names the table. */
export function toPortalPage<T extends ResolvedTable>(model: ModelDef, table: string, page: T): ResolvedTable {
  const refs: LookupRef[] = [
    ...model.parameters.flatMap((p) => (p.domain?.kind === "options" ? [p.domain.ref] : [])),
    ...(model.tables ?? []).flatMap((t) => t.columns.flatMap((c) => (c.cell.kind === "options" ? [c.cell.ref] : []))),
  ].filter((r) => r.source !== "manual" && r.table === table);
  return portalTableData(page, refs);
}

// --- input: what a client may write (spec §7.1) ----------------------------------------------

/** The cells of a table row a client may type: the declared non-formula columns. A formula cell
 *  typed over is a salesperson's override, and a typed unit price is a salesperson's price. */
const writableCols = (t: TableDef) => new Set(t.columns.filter((c) => c.cell.kind !== "formula").map((c) => c.key));

/** A stored table as the client receives it: writable cells only. What staff typed over stays on
 *  the server — and survives a client save that leaves the table alone (acceptPortalInputs). */
export function toPortalRows(model: ModelDef, tableRows: TableRows): TableRows {
  return Object.fromEntries((model.tables ?? []).map((t) => {
    const cols = writableCols(t);
    return [t.key, (tableRows[t.key] ?? []).map((r) => Object.fromEntries(Object.entries(r).filter(([c]) => cols.has(c))))];
  }));
}

/**
 * A client's edit, checked against what is stored. A change is refused when it touches what the
 * client may not write: an entry key outside the model's parameters or on a read-only one, a table
 * the model does not declare, a cell on a formula column or on unitcost/unitprice. What did not
 * change passes as it is — so an entry or an override staff stored, which the client was sent
 * back untouched, is never a reason to refuse the client's own edit.
 *
 * A table the client sent unchanged keeps its stored rows, staff overrides included; a table the
 * client changed becomes the client's rows.
 * ponytail: per-table, not per-cell — a client edit to a table drops staff's overrides in that
 * table. Rows have no identity to merge on; add row ids if reviewers start losing overrides.
 *
 * Returns the inputs to write, or throws an Error naming what was refused.
 */
export function acceptPortalInputs(
  model: ModelDef,
  stored: { entries: Entries; tables: TableRows },
  incoming: { entries?: Entries; tables?: TableRows },
): { entries?: Entries; tables?: TableRows } {
  const out: { entries?: Entries; tables?: TableRows } = {};
  if (incoming.entries) {
    const params = new Map(model.parameters.map((p) => [p.key, p]));
    const next = incoming.entries;
    const refused = [...new Set([...Object.keys(stored.entries), ...Object.keys(next)])]
      .filter((k) => !sameJson(stored.entries[k], next[k]))
      .filter((k) => { const p = params.get(k); return !p || p.readonly; });
    if (refused.length) throw new Error(`Not editable here: ${refused.join(", ")}`);
    out.entries = next;
  }
  if (incoming.tables) {
    const defs = new Map((model.tables ?? []).map((t) => [t.key, t]));
    const sent = toPortalRows(model, stored.tables);
    const merged: TableRows = { ...stored.tables };
    for (const [key, rows] of Object.entries(incoming.tables)) {
      const def = defs.get(key);
      if (!def) throw new Error(`Not editable here: table ${key}`);
      if (sameJson(rows, sent[key] ?? [])) continue;
      const cols = writableCols(def);
      const refused = [...new Set(rows.flatMap((r) => Object.keys(r).filter((c) => !cols.has(c))))];
      if (refused.length) throw new Error(`Not editable here: ${def.title || key} → ${refused.join(", ")}`);
      merged[key] = rows;
    }
    out.tables = merged;
  }
  return out;
}
