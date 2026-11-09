import {
  displayColumns, refKeyCols, structureId,
  type LookupRef, type ModelDef, type ResolvedLookups, type ResolvedTable, type TableRows, type Val,
} from "./model";
import { domainOf, paramPrices, type DomainOption, type Propagation } from "./propagate";
import { evalTableRows } from "./tables";

/** One option as the form draws it. `unavailable` is the rule that eliminated it; `extra` the
 *  ref's display columns for that row, shown next to the option. */
export type FieldOption = { value: Val; label: string; unavailable?: string; extra?: string };

/** One parameter as the form draws it. Absent `value` = unset. */
export type FieldState = {
  value?: Val;
  /** the value came from the parameter's default, not from the user */
  defaulted?: true;
  visible: boolean;
  /** mandatory, or `requiredWhen` holds — and visible */
  required: boolean;
  options?: FieldOption[];
  /** the informational price badge (`priceExpr`), for the current value */
  price?: number;
  /** the messages of every rule this field is part of and currently breaks */
  conflicts?: string[];
};

/** What a configuration form shows, worked out from one propagation. Plain JSON on purpose (no
 *  Set, no Map): the RPC client, /api/openapi and an MCP client all read the same thing, and the
 *  form computes nothing from it. Parameter keys only — computed values and `<param>_<column>`
 *  derived keys stay home, so the portal's fence has nothing to strip but hidden values. */
export type FormState = {
  fields: Record<string, FieldState>;
  /** rule violations: the author's message and the parameters it involves */
  conflicts: { message: string; params: string[] }[];
  /** how many fields are still open */
  open: number;
  /** each table's rows evaluated — formula cells filled in, declared columns only */
  tables: Record<string, Record<string, Val>[]>;
  /** structureIds of the sections and field groups the rules hide; absent = none */
  hidden?: string[];
  /** each tenant visual's view, by key: the placed ones in a shown section and group that have one
   *  (plain JSON, drawn by @confire/ui's VISUAL_VIEWS); absent = none. Staff only — toPortalForm
   *  drops it. */
  visuals?: Record<string, unknown>;
};

/** The ref's display columns for one option value, joined. A `table` ref only: its rows are the
 *  whole masterdata, so the row is always there; a query option shows its label and nothing else. */
function extraOf(ref: LookupRef, t: ResolvedTable | undefined, val: Val): string | undefined {
  if (!t || ref.source !== "table") return undefined;
  const { valueCol } = refKeyCols(ref, t.columns);
  const vi = t.columns.indexOf(valueCol);
  const row = vi < 0 ? undefined : t.rows.find((r) => r[vi] === val);
  if (!row) return undefined;
  // The option already carries its code; it is repeated beside it only when the author picked it.
  const hidden = new Set([...(t.hidden ?? []), ...(ref.columns ? [] : [valueCol])]);
  const s = displayColumns(ref, t.columns).filter((c) => !hidden.has(c))
    .map((c) => String(row[t.columns.indexOf(c)] ?? "")).filter(Boolean).join(" · ");
  return s || undefined;
}

export function formState(model: ModelDef, lookups: ResolvedLookups, prop: Propagation, tableRows: TableRows): FormState {
  const broken: Record<string, string[]> = {};
  for (const c of prop.conflicts) for (const k of c.params) (broken[k] ??= []).push(c.message);
  const prices = new Map(paramPrices(model, prop, lookups.tables).map((c) => [c.key, c.amount]));

  const fields: Record<string, FieldState> = {};
  for (const p of model.parameters) {
    const ref = p.domain?.kind === "options" ? p.domain.ref : undefined;
    const t = ref && ref.source !== "manual" ? lookups.tables[ref.table] : undefined;
    // An excluded parameter has no propagated domain; its raw options still label its value.
    const dom: DomainOption[] = prop.domains[p.key] ?? domainOf(model, lookups, p.key);
    const f: FieldState = { visible: prop.visible[p.key] !== false, required: !!prop.required[p.key] };
    if (p.key in prop.values) f.value = prop.values[p.key];
    if (prop.defaulted.has(p.key)) f.defaulted = true;
    if (dom.length)
      f.options = dom.map((o) => {
        const extra = ref ? extraOf(ref, t, o.value) : undefined;
        return {
          value: o.value, label: o.label,
          ...(o.eliminatedBy ? { unavailable: o.eliminatedBy } : {}),
          ...(extra ? { extra } : {}),
        };
      });
    if (prices.has(p.key)) f.price = prices.get(p.key)!;
    if (broken[p.key]) f.conflicts = broken[p.key];
    fields[p.key] = f;
  }

  const visualKeys = new Set((model.visuals ?? []).map((v) => v.key));
  const visuals: Record<string, unknown> = {};
  for (const s of model.structure.sections) {
    if (prop.hiddenStructure.has(structureId(s.key))) continue;
    for (const g of s.groups) {
      if (prop.hiddenStructure.has(structureId(s.key, g.key))) continue;
      for (const k of g.params) if (visualKeys.has(k) && prop.views[k] !== undefined) visuals[k] = prop.views[k];
    }
  }

  return {
    fields,
    conflicts: prop.conflicts.map((c) => ({ message: c.message, params: c.params })),
    open: prop.open.length,
    tables: Object.fromEntries((model.tables ?? []).map((def) => {
      const cols = def.columns.map((c) => c.key);
      const rows = evalTableRows(def, tableRows[def.key] ?? [], prop.values, lookups.tables);
      return [def.key, rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])))];
    })),
    ...(prop.hiddenStructure.size ? { hidden: [...prop.hiddenStructure] } : {}),
    ...(Object.keys(visuals).length ? { visuals } : {}),
  };
}
