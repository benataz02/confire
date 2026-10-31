import {
  refKeyCols,
  type FormState, type LookupRef, type ModelDef, type Param, type ResolvedLookups, type ResolvedTable,
  type TableDef, type TableRows,
} from "@confire/config-engine";
import type { ConfigCandidate, PortalPrice } from "@confire/db";

// What the portal configurator receives (spec §7.1). The engine runs on the server; the client gets
// a projection of the model, the form state and the lookups — enough to draw the form, nothing to
// price with. This module IS the fence, so each function names what it keeps rather than what it
// drops: a field added to ModelDef later stays home until someone adds it here.

/** A parameter's display shape. Every expression stays home — defaults, visibility, requiredness
 *  and prices are the server's, and arrive evaluated in toPortalForm. */
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
    pricing: { margin: 0, quoteItemCode: "" },
    batchDefaults: [],
  };
}

/** The form state as a client may see it. formState already holds parameter keys only (no computed
 *  value, no `<param>_<column>` derived key, which can carry any column of a masterdata row) and
 *  declared table columns only (a typed unit price is not one). What stays home here: everything
 *  about a field the rules hide — a hidden field is not drawn, so its value and options have nowhere
 *  to go but the wire — and the price badges unless the model shows indicative prices. */
export function toPortalForm(form: FormState, indicative: boolean): FormState {
  return {
    ...form,
    fields: Object.fromEntries(Object.entries(form.fields).map(([k, f]) => {
      if (!f.visible) return [k, { visible: false, required: false }];
      const { price, ...rest } = f;
      return [k, indicative && price !== undefined ? { ...rest, price } : rest];
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
 *  columns. `prices` never goes, and neither do domains: a field's options are in the form state. */
export function toPortalLookups(model: ModelDef, form: FormState, lookups: ResolvedLookups): { tables: Record<string, ResolvedTable> } {
  const refs = new Map<string, LookupRef[]>();
  const add = (r: LookupRef) => { if (r.source !== "manual") refs.set(r.table, [...(refs.get(r.table) ?? []), r]); };
  for (const p of model.parameters) if (form.fields[p.key]?.visible && p.domain?.kind === "options") add(p.domain.ref);
  for (const t of model.tables ?? []) for (const c of t.columns) if (c.cell.kind === "options") add(c.cell.ref);
  const tables: Record<string, ResolvedTable> = {};
  for (const [name, rs] of refs) {
    const t = lookups.tables[name];
    if (t) tables[name] = portalTableData(t, rs);
  }
  return { tables };
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

/** A table query page as the portal may see it (the value help): the same column rule as the
 *  canonical tables, against every ref of the model that names the table. */
export function toPortalPage<T extends ResolvedTable>(model: ModelDef, table: string, page: T): ResolvedTable {
  const refs: LookupRef[] = [
    ...model.parameters.flatMap((p) => (p.domain?.kind === "options" ? [p.domain.ref] : [])),
    ...(model.tables ?? []).flatMap((t) => t.columns.flatMap((c) => (c.cell.kind === "options" ? [c.cell.ref] : []))),
  ].filter((r) => r.source !== "manual" && r.table === table);
  return portalTableData(page, refs);
}

// --- what a client may write (spec §7.1) ------------------------------------------------------
// The rules themselves are config-patch.ts' external side: the declared non-formula cells, no
// read-only parameter, no typed unit price.

/** A stored table as the client receives it: writable cells only. What staff typed over stays on
 *  the server, and survives every client edit that leaves the table alone. */
export function toPortalRows(model: ModelDef, tableRows: TableRows): TableRows {
  return Object.fromEntries((model.tables ?? []).map((t) => {
    const cols = new Set(t.columns.filter((c) => c.cell.kind !== "formula").map((c) => c.key));
    return [t.key, (tableRows[t.key] ?? []).map((r) => Object.fromEntries(Object.entries(r).filter(([c]) => cols.has(c))))];
  }));
}
