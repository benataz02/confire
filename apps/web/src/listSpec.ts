import type { AnalyticalTableColumnDefinition } from "@ui5/webcomponents-react";
import type { B1Field } from "@confire/b1";
import type { ListVariantDef, FilterCond, ObjectVariantDef } from "@confire/db";

// The pure half of a list view: column descriptors, the local executor, cell formatting. No hooks,
// no orpc — variants.ts re-exports all of it, and the test imports this module directly (orpc.ts
// touches `window` at module scope, so anything importing it can't be unit-tested under bun).

export type { ListVariantDef, FilterCond, FilterOp, ObjectVariantDef } from "@confire/db";

// VariantManagement's dialog flags come back as boolean | "true" | "false" (string-bool). Coerce.
export const truthy = (v: unknown): boolean => v === true || v === "true";

// Dirty = live view differs from the saved one.
//
// Object keys are SORTED before comparing, arrays are not. `definition` is jsonb, and Postgres
// stores object keys in its own order (by length, then bytewise), so a view read back after a Save
// arrives as {op, field, value} where the browser wrote {field, op, value} — a plain JSON.stringify
// leaves the dirty asterisk on forever. Array order is left alone: column, sort and filter order
// are meaningful parts of the view. Same job as canonicalJson in apps/server/src/config-quote.ts,
// which hashes jsonb for the same reason; too small to share across the server/browser boundary.
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
export const sameDef = (a: unknown, b: unknown): boolean => canon(a) === canon(b);

// A column as ListReport needs it. B1 pages map schema.fields through schemaColumns; local pages
// hand-write the optional fields. `Cell` and `options` must be stable references — AnalyticalTable memoization.
export type ListColumn = {
  name: string;
  type: string;
  /** human header; a variant's `labels` override still wins */
  label?: string;
  /** renders a MultiComboBox in the FilterBar instead of a free-text Input */
  options?: { value: string; text: string }[];
  /** custom cell renderer; receives the raw (unformatted) value. Type-only import, erased at build. */
  Cell?: AnalyticalTableColumnDefinition["Cell"];
};

/** The fields a B1 schema contributes to a list. Collections belong on the object page.
 *  Boolean kind is rewritten to Edm.Boolean: BoYesNoEnum's edmType is `SAPB1.BoYesNoEnum`,
 *  which the filter bar's `/bool/i` test would miss and render as a text input. */
export const schemaColumns = (
  fields: {
    name: string;
    kind: string;
    edmType: string;
    label?: string;
    options?: { value: string; label: string }[];
  }[],
): ListColumn[] =>
  fields
    .filter((f) => f.kind !== "collection")
    .map((f) => ({
      name: f.name,
      type: f.kind === "boolean" ? "Edm.Boolean" : f.edmType,
      label: f.label ?? f.name,
      ...(f.options ? { options: f.options.map((o) => ({ value: o.value, text: o.label })) } : {}),
    }));

const isDateType = (t: string) => /date|time/i.test(t);
export const isTextType = (t: string) => /string|char|memo|guid|text/i.test(t);

export const EMPTY_SPEC: ListVariantDef = { select: [], filter: [], orderby: [], filterBar: [] };

/** A boolean filter has three states, not two: undefined = unfiltered. */
export const boolFilterState = (c?: FilterCond): boolean | undefined =>
  c ? c.value === true || c.value === "true" : undefined;

/** Click cycle for the filter bar's boolean checkbox: Any -> Yes -> No -> Any ("" clears). */
export const nextBoolFilter = (v: boolean | undefined): boolean | "" =>
  v === undefined ? true : v ? false : "";

/** Option-filter values: a saved `eq` is one value; MultiComboBox writes `in` as an array.
 *  The unfiltered case returns one shared array rather than a fresh `[]`: MultiComboBox's
 *  `selectedValues` is a *property*, not an attribute, so withWebComponent assigns it from a
 *  useEffect keyed on value identity — a new array each render is a DOM write and a web-component
 *  invalidation per render, on every option column that has no filter. */
const NO_OPTION_VALUES: string[] = [];
export const optionFilterValues = (c?: FilterCond): string[] =>
  !c ? NO_OPTION_VALUES : (Array.isArray(c.value) ? c.value : [c.value]).map(String);

// Rendered columns only — the server unions in the schema's identity keys for the OData $select.
export const visibleColumns = (spec: ListVariantDef, columns: ListColumn[]): string[] =>
  spec.select.length ? spec.select : columns.map((c) => c.name);

// --- object views --------------------------------------------------------------------------------
// The object-page half of a saved view. `header` is the scalar form, `sections[].id` names a
// collection and `sections[].fields` its table columns — so one function answers both "which fields"
// and "which sections", and EntityField renders the narrowed collection unchanged because its
// columns come from `field.fields`. Same projection shape as portalSchema on the server.

/** Fields a view names, in the view's order. A name with no matching field is dropped rather than
 *  thrown: the same rule compileList applies to `select`, so a view outliving a UDF still opens. */
const pickFields = (all: B1Field[], want: ObjectVariantDef["header"]): B1Field[] =>
  want.flatMap((w) => {
    if (!w.visible) return [];
    const hit = all.find((f) => f.name === w.name);
    return hit ? [w.label ? { ...hit, label: w.label } : hit] : [];
  });

/**
 * One B1 schema + one object view -> what the ObjectPage draws.
 *
 * A view with neither half filled means "show everything" — the same emptiness test the seeder uses
 * to decide a Standard row has never been shaped (seed-variants.ts), so the two cannot drift.
 *
 * `always` is the escape hatch that keeps the page usable in edit/create mode: a hand-edited view
 * that drops CardCode would otherwise make a create page unable to send a field the server requires.
 */
export function applyObjectDef(
  fields: B1Field[],
  def: ObjectVariantDef | null,
  always: string[] = [],
): { scalars: B1Field[]; sections: B1Field[] } {
  const scalars = fields.filter((f) => f.kind !== "collection");
  const collections = fields.filter((f) => f.kind === "collection");
  if (!def || (!def.header.length && !def.sections.length)) return { scalars, sections: collections };

  const header = def.header.length ? pickFields(scalars, def.header) : scalars;
  const missing = always.filter((n) => !header.some((f) => f.name === n));
  return {
    scalars: [...header, ...scalars.filter((f) => missing.includes(f.name))],
    sections: def.sections.flatMap((s) => {
      if (!s.visible) return [];
      const c = collections.find((f) => f.name === s.id);
      if (!c) return [];
      return [s.fields.length ? { ...c, fields: pickFields(c.fields ?? [], s.fields) } : c];
    }),
  };
}

/** The part of a saved view that IS the query, and nothing else. `labels` and `filterBar` are
 *  presentation: no executor reads them, but they live in the same jsonb document,
 *  and that document is the oRPC infinite-query key — so without this projection a header rename
 *  mints a new key and throws away every loaded page. `select` is sorted because
 *  reordering columns doesn't change what $select asks for either.
 *  Every list fetch input goes through here. */
export const listQuery = (spec: ListVariantDef): ListVariantDef => ({
  select: [...spec.select].sort(),
  filter: spec.filter,
  orderby: spec.orderby,
  filterBar: [],
  ...(spec.search ? { search: spec.search } : {}),
});

// Table cells are strings. Dates render as the local date alone — B1's date columns come back as
// "2026-08-28T00:00:00Z" and the time half is never meaningful.
//
// The y/m/d are read off the string rather than through `new Date(v).toLocaleDateString()`: that
// parses "…T00:00:00Z" as UTC midnight, which is the *previous* day anywhere west of Greenwich.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
export const formatCell = (v: unknown, type = ""): string => {
  if (v == null) return "";
  if (isDateType(type)) {
    if (type === "Edm.Time" || type === "Edm.TimeOfDay") return String(v);
    const iso = ISO_DATE.exec(String(v));
    if (iso) return new Date(+iso[1]!, +iso[2]! - 1, +iso[3]!).toLocaleDateString();
    const d = new Date(v as string | number | Date);
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString();
  }
  return typeof v === "object" ? JSON.stringify(v) : String(v);
};
