import { z } from "zod";
import { sql, type SQL } from "drizzle-orm";
import { configProject } from "@confire/db";
import {
  EntriesZ, PRICE_COL, TableRowsZ,
  type Entries, type ModelDef, type Param, type TableDef, type TableRows, type Val,
} from "@confire/config-engine";
import type { Side } from "./project-lifecycle.ts";

// One edit to a configuration's engine inputs, as both processes take it: the fields that changed
// and nothing else. Validated against the model before anything is written, then merged in SQL so
// two writers editing different fields (a browser tab and an MCP session) never overwrite each other.

export const PatchZ = {
  set: EntriesZ.optional()
    .describe("Parameter values to write, by parameter key: a number, a string, a boolean, null, or a list of strings for a multi-select. Keys not named are left alone."),
  unset: z.array(z.string()).optional()
    .describe("Parameter keys to clear, so the field is open again (null is a value, so clearing needs its own list)."),
  batches: z.array(z.number().int().min(1)).max(50).optional()
    .describe("The batch quantities to price, as the whole list."),
  tables: TableRowsZ.optional()
    .describe("Each changed table's full rows, by table key. A table not named is left alone."),
};

export type InputPatch = { set?: Entries; unset?: string[]; batches?: number[]; tables?: TableRows };

/** Does the patch touch what the engine reads? Then it empties the calculation in the same write. */
export const touchesEngine = (p: InputPatch): boolean =>
  Object.keys(p.set ?? {}).length > 0 || (p.unset?.length ?? 0) > 0 || p.batches !== undefined
  || Object.keys(p.tables ?? {}).length > 0;

const scalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Why a parameter refuses this value, or null. A value outside the field's options is not refused:
 *  options depend on other fields and on the cache, so the view reports it instead (`not_an_option`).
 *  Which is also why an options field takes any scalar — its options carry their own types. */
function paramProblem(p: Param, v: Val | undefined): string | null {
  if (p.readonly) return "read-only";
  if (v === undefined) return null; // an unset
  if (p.ui === "multicombo") return strings(v) || v === null ? null : "expects a list of strings";
  if (!scalar(v)) return `expects a ${p.type}`;
  if (v === null || p.domain?.kind === "options") return null;
  return typeof v === p.type ? null : `expects a ${p.type}`;
}

/** Why a table cell refuses this value, or null. External: the client types the declared input and
 *  option cells — a formula typed over is a salesperson's override, and a typed unit price is a
 *  salesperson's price. */
function cellProblem(def: TableDef, key: string, v: Val, side: Side): string | null {
  if (key === PRICE_COL && def.role === "items") {
    if (side === "external") return "set by the supplier";
    return v === null || (typeof v === "number" && v >= 0) ? null : "expects a price of 0 or more";
  }
  const c = def.columns.find((x) => x.key === key);
  if (!c) return "not a column of this table";
  if (c.cell.kind === "formula" && side === "external") return "computed, not editable here";
  if (v === null) return null;
  if (c.cell.kind === "options") return scalar(v) || strings(v) ? null : `expects a ${c.type}`;
  return typeof v === c.type ? null : `expects a ${c.type}`;
}

/**
 * Every problem with a patch, by field, so a refusal can name them all at once and a client can
 * correct itself: a key that is not a parameter, a read-only parameter, a value of the wrong type,
 * a table or a column the model does not declare. Empty = accept.
 */
export function patchProblems(model: ModelDef, patch: InputPatch, side: Side): string[] {
  const params = new Map(model.parameters.map((p) => [p.key, p]));
  const defs = new Map((model.tables ?? []).map((t) => [t.key, t]));
  const out: string[] = [];
  const field = (key: string, v: Val | undefined) => {
    const p = params.get(key);
    const problem = p ? paramProblem(p, v) : "not a field of this model";
    if (problem) out.push(`${key}: ${problem}`);
  };
  for (const [k, v] of Object.entries(patch.set ?? {})) field(k, v);
  for (const k of patch.unset ?? []) field(k, undefined);
  for (const [key, rows] of Object.entries(patch.tables ?? {})) {
    const def = defs.get(key);
    if (!def) { out.push(`${key}: not a table of this model`); continue; }
    const seen = new Set<string>();
    for (const r of rows)
      for (const [col, v] of Object.entries(r)) {
        const problem = cellProblem(def, col, v, side);
        const msg = problem && `${def.title || key} → ${col}: ${problem}`;
        if (msg && !seen.has(msg)) { seen.add(msg); out.push(msg); }
      }
  }
  return out;
}

/**
 * The patch as UPDATE columns that merge in SQL: `entries = (entries || set) - unset…`,
 * `tables = tables || tables`. A key in both `set` and `unset` ends up cleared.
 *
 * ponytail: tables are replaced per table, not per cell — rows have no identity to merge on, so a
 * client's edit to a table drops a salesperson's overrides in it. Per-row patches once rows get ids.
 */
export function patchColumns(p: InputPatch): { entries?: SQL; tables?: SQL; batches?: number[] } {
  const out: { entries?: SQL; tables?: SQL; batches?: number[] } = {};
  if (Object.keys(p.set ?? {}).length || p.unset?.length) {
    // `jsonb - text` once per key: drizzle spreads an array parameter into a list, so a text[] would
    // not survive as one parameter.
    out.entries = sql`(${configProject.entries} || ${JSON.stringify(p.set ?? {})}::jsonb)${sql.join((p.unset ?? []).map((k) => sql` - ${k}::text`))}`;
  }
  if (Object.keys(p.tables ?? {}).length) out.tables = sql`${configProject.tables} || ${JSON.stringify(p.tables)}::jsonb`;
  if (p.batches !== undefined) out.batches = p.batches;
  return out;
}
