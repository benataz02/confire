import type { Constraint, ModelDef } from "@confire/config-engine";
import type { Row } from "@confire/ui/types.ts";

// The model builder edits one record: the definition's top-level parts, `pricing` and `history`
// flattened to dotted keys (each equal to checkModel's issue path, so an issue lands on its field
// with no mapping), the constraints split by kind (the page lists them apart), and the portal
// columns of the `config_model` row beside them.

export type PortalPricing = "indicative" | "request";
/** What the builder saves: the definition and the two portal columns beside it. */
export type ModelRow = { definition: ModelDef; portal: boolean; portalPricing: PortalPricing };

const PRICING = ["priceList", "itemTable", "priceExpr", "quoteItemCode"] as const;
const HISTORY = ["table", "mappings", "display"] as const;

export type ExprRule = Extract<Constraint, { kind: "expr" }>;
export type ComboTable = Extract<Constraint, { kind: "table" }>;

export function toRecord(m: ModelRow): Row {
  const { pricing, history, constraints, ...rest } = m.definition;
  return {
    ...rest,
    ...Object.fromEntries(PRICING.map((k) => [`pricing.${k}`, pricing[k]])),
    ...Object.fromEntries(HISTORY.map((k) => [`history.${k}`, history?.[k]])),
    // Expression rules are a grid of their own; their order among the combination tables is not
    // something a model means, so the record keeps each kind's order and puts the rules first.
    constraints: constraints.filter((c) => c.kind === "expr"),
    combinations: constraints.filter((c) => c.kind === "table"),
    portal: m.portal,
    portalPricing: m.portalPricing,
  };
}

export function fromRecord(r: Row): ModelRow {
  const def: Record<string, unknown> = {};
  const pricing: Record<string, unknown> = {};
  const history: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k.startsWith("pricing.")) pricing[k.slice(8)] = v;
    else if (k.startsWith("history.")) history[k.slice(8)] = v;
    else if (k !== "portal" && k !== "portalPricing" && k !== "combinations") def[k] = v;
  }
  def.pricing = pricing;
  def.constraints = [...((r.constraints as Constraint[] | undefined) ?? []), ...((r.combinations as Constraint[] | undefined) ?? [])];
  if (HISTORY.some((k) => history[k] !== undefined))
    def.history = { ...history, mappings: history.mappings ?? [], display: history.display ?? [] };
  return {
    definition: def as ModelDef,
    portal: !!r.portal,
    portalPricing: (r.portalPricing as PortalPricing | undefined) ?? "request",
  };
}

/** The definition of a record. */
export const defOf = (r: Row): ModelDef => fromRecord(r).definition;

/** An edit of the definition, as an edit of the record: structureOps and the templates work on a
 *  ModelDef, the record keeps the portal columns beside it. */
export const withDef = (fn: (d: ModelDef) => ModelDef) => (r: Row): Row => {
  const m = fromRecord(r);
  return toRecord({ ...m, definition: fn(m.definition) });
};

/** Where a constraint's issue lands: an expression rule is its grid's row, a combination table the
 *  combination list's. `i` is its index in the definition, which `fromRecord` lays out rules first. */
export function constraintAt(r: Row, i: number): { table: "constraints" | "combinations"; row: number } {
  const rules = ((r.constraints as unknown[] | undefined) ?? []).length;
  return i < rules ? { table: "constraints", row: i } : { table: "combinations", row: i - rules };
}
