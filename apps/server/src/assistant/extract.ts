import { z } from "zod";
import type { Entries, FieldOption, FormState, ModelDef, Param, TableDef, TableRows, Val } from "@confire/config-engine";
import type { ValueSource } from "@confire/db";

// Extraction (assistant spec §4.4): one structured call reads the client's files against the chosen
// model, and the server turns the answer into one `configs.calculate` patch plus questions. This half
// is pure: what the model is told (`modelBlock`), the shape its answer must fit (`extractionSchema`),
// and the rules that decide what is written and what is asked (`planApply`). Values fill empty fields
// only; anything the model was not sure of, or that disagrees with the configuration, is asked.

/** Above this many options a list is a string in the schema, validated by the patch instead. */
export const ENUM_MAX = 60;

export type FileSource = { file: string; page: number | null; quote: string };
export type Extraction = {
  set: { key: string; value: Val; source: FileSource }[];
  batches: { qtys: number[]; source: FileSource } | null;
  tables: { table: string; rows: Record<string, Val>[]; source: FileSource }[];
  unsure: { key: string; why: string; candidates: Val[] }[];
  notes: string[];
};

export type Question = {
  key: string;
  why: "differs" | "not_an_option" | "out_of_range" | "unavailable" | "unsure" | "ambiguous";
  detail: string;
  /** what was read: a parameter's value, or the quantities/rows read for `batches`/a table */
  read?: unknown;
  /** the values to offer: the current one against the read one, the two readings, the model's guesses */
  candidates: unknown[];
};

export type Plan = {
  patch: { set: Entries; batches?: number[]; tables?: TableRows };
  sources: Record<string, ValueSource>;
  questions: Question[];
  notes: string[];
};

const writable = (def: ModelDef) => def.parameters.filter((p) => !p.readonly);
const isQuery = (p: Param) => p.domain?.kind === "options" && p.domain.ref.source === "query";
/** Every option the field lists, ruled out or not: a rule's verdict moves with the entries, the
 *  list itself only with the model and its masterdata. */
const optionsOf = (p: Param, form: FormState): FieldOption[] =>
  form.fields[p.key]?.options
  ?? (p.domain?.kind === "options" && p.domain.ref.source === "manual"
    ? p.domain.ref.options.map((o) => ({ value: o.value, label: o.label ?? String(o.value) }))
    : []);
const inputColumns = (t: TableDef) => t.columns.filter((c) => c.cell.kind !== "formula");
const canon = (v: unknown) => JSON.stringify(v);
const TYPE = { string: "text", number: "number", boolean: "yes/no" } as const;
const show = (v: Val) => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * The model as the extraction reads it: description, every writable parameter (visible or not — a
 * value read off the drawing can be what makes another field visible), the rules and the tables.
 * Deterministic for a model version and its masterdata, so it carries the prompt cache breakpoint:
 * it lists options whether or not a rule rules them out right now.
 */
export function modelBlock(def: ModelDef, form: FormState): string {
  const out = [`# Model: ${def.name}`];
  if (def.description) out.push(def.description);
  out.push("", "## Parameters (key — label)");
  for (const p of writable(def)) {
    const facts = [`${p.ui === "multicombo" ? "list of " : ""}${TYPE[p.type]}${p.unit ? `, ${p.unit}` : ""}`];
    if (p.mandatory) facts.push("required");
    if (p.requiredWhen) facts.push(`required when ${p.requiredWhen}`);
    if (p.visibleWhen) facts.push(`shown when ${p.visibleWhen}`);
    let allowed = "";
    if (p.domain?.kind === "range") allowed = ` Range ${p.domain.min}–${p.domain.max}${p.domain.step ? ` step ${p.domain.step}` : ""}.`;
    else if (isQuery(p)) allowed = " One of a SAP list (search by text).";
    else if (p.domain?.kind === "options") {
      // ponytail: a manual or table list is hand-typed, so tens of values — listed whole even
      // past ENUM_MAX; a list long enough to hurt the cache belongs in a query table.
      const opts = optionsOf(p, form).map((o) => (o.label && o.label !== show(o.value) ? `${show(o.value)} (${o.label})` : show(o.value)));
      allowed = ` One of: ${opts.join(", ")}.`;
    }
    out.push(`- ${p.key} — ${p.label} (${facts.join("; ")}).${allowed}${p.help ? ` Help: ${p.help}` : ""}`);
  }
  if (def.constraints.length) {
    out.push("", "## Rules");
    for (const c of def.constraints)
      out.push(c.kind === "expr"
        ? `- ${c.message}: ${c.when ? `when ${c.when}, ` : ""}${c.assert}`
        : `- ${c.mode === "allow" ? "Allowed" : "Forbidden"} combinations of ${c.params.join(", ")}: ${c.rows.map((r) => `(${r.map(show).join(", ")})`).join("; ")}`);
  }
  for (const t of def.tables ?? []) {
    out.push("", `## ${t.role === "items" ? "Items grid" : "Table"} "${t.title}" (key ${t.key}), one row per line`);
    out.push(`Columns: ${inputColumns(t).map((c) => `${c.key} — ${c.label} (${TYPE[c.type]}${c.unit ? `, ${c.unit}` : ""})`).join(", ")}`);
  }
  return out.join("\n");
}

const SourceSchema = z.object({
  file: z.string().describe("The file's name, as given"),
  page: z.number().nullable().describe("The page the text is on, or null for an image"),
  quote: z.string().describe("The exact text read, as written"),
});

/** A parameter's value as the schema takes it. Bounds are checked in code: Claude refuses them. */
function valueSchema(p: Param, form: FormState): z.ZodType {
  if (p.ui === "multicombo") return z.array(z.string());
  if (p.type === "boolean") return z.boolean();
  if (p.domain?.kind === "options" && !isQuery(p)) {
    const vals = optionsOf(p, form).map((o) => o.value).filter((v): v is string | number | boolean => v !== null && !Array.isArray(v));
    if (vals.length && vals.length <= ENUM_MAX)
      return vals.every((v) => typeof v === "string") ? z.enum(vals as [string, ...string[]]) : z.literal(vals as [string, ...string[]]);
  }
  // a query-backed value is checked against the cache, whatever the parameter's type
  return p.type === "number" && !isQuery(p) ? z.number() : z.string();
}

const cellSchema = (type: "string" | "number" | "boolean") =>
  (type === "number" ? z.number() : type === "boolean" ? z.boolean() : z.string()).nullable();

/** One of `options`, or nothing at all when the model has none (an empty list fits). A plain union:
 *  a discriminated one becomes `oneOf`, which Claude's structured output does not take (`anyOf`). */
const oneOf = (options: z.ZodObject[]) => (options.length ? z.union(options) : z.never());

/**
 * The answer's schema, generated from the model: a `set` item can only name a writable parameter
 * with a value of its type (the option list itself when short), a table only a declared one with its
 * input columns. Objects only, no records: Claude's structured output takes `additionalProperties:
 * false` and nothing else.
 */
export function extractionSchema(def: ModelDef, form: FormState): z.ZodType<Extraction> {
  const params = writable(def);
  const tables = def.tables ?? [];
  const keys = [...params.map((p) => p.key), ...tables.map((t) => t.key), "batches"];
  return z.object({
    set: z.array(oneOf(params.map((p) => z.object({ key: z.literal(p.key), value: valueSchema(p, form), source: SourceSchema }))))
      .describe("Every value read off the files or the text, with where it was read. Only what is written there."),
    batches: z.object({ qtys: z.array(z.number()), source: SourceSchema }).nullable()
      .describe("The quantities the client asks prices for, or null when none are written"),
    tables: z.array(oneOf(tables.map((t) => z.object({
      table: z.literal(t.key),
      rows: z.array(z.object(Object.fromEntries(inputColumns(t).map((c) => [c.key, cellSchema(c.type)])))),
      source: SourceSchema,
    })))).describe("Lines read into a table, e.g. a drawing's parts list"),
    unsure: z.array(z.object({
      key: z.enum(keys as [string, ...string[]]),
      why: z.string().describe("What makes it unsure: illegible, two readings, not stated…"),
      candidates: z.array(z.union([z.string(), z.number(), z.boolean()])).describe("The possible readings, if any"),
    })).describe("Fields read, but not with confidence: they are asked, never written"),
    notes: z.array(z.string()).describe("Anything the client asks for that no field holds"),
  }) as unknown as z.ZodType<Extraction>;
}

const empty = (v: unknown) => v === undefined || v === null || v === "";

/**
 * What a read writes and what it asks, from its arguments alone. In order: a key read two ways is
 * ambiguous; a field already holding a value is left alone (a different value is a question); an
 * option the list lacks, or a rule rules out, is asked with the rule; a number out of range is
 * asked, never clamped; the rest is written with its source. Batches replace the model's untouched
 * defaults only, a table is filled only while empty.
 */
export function planApply(
  def: ModelDef,
  view: { entries: Entries; batches: number[]; tables: TableRows; form: FormState },
  x: Extraction,
  inQuery: (key: string, v: Val) => boolean,
): Plan {
  const params = new Map(def.parameters.map((p) => [p.key, p]));
  const set: Entries = {};
  const sources: Record<string, ValueSource> = {};
  const questions: Question[] = [];
  const ask = (q: Question) => questions.push(q);

  const reads = new Map<string, Extraction["set"]>();
  for (const r of x.set) reads.set(r.key, [...(reads.get(r.key) ?? []), r]);
  for (const [key, rs] of reads) {
    const p = params.get(key);
    if (!p || p.readonly) continue; // the schema already refuses these
    const distinct = [...new Map(rs.map((r) => [canon(r.value), r.value])).values()];
    if (distinct.length > 1) {
      ask({ key, why: "ambiguous", detail: `Read as ${distinct.map(show).join(" and ")}`, candidates: distinct });
      continue;
    }
    const { value, source } = rs[0]!;
    const cur = view.entries[key];
    if (!empty(cur)) {
      if (canon(cur) !== canon(value)) ask({ key, why: "differs", detail: `The field holds ${show(cur!)}; read ${show(value)}`, read: value, candidates: [cur, value] });
      continue;
    }
    if (p.domain?.kind === "options") {
      if (isQuery(p)) {
        if (!inQuery(key, value)) { ask({ key, why: "not_an_option", detail: `${show(value)} is not in the list`, read: value, candidates: [] }); continue; }
      } else {
        const opts = optionsOf(p, view.form);
        const picked = (Array.isArray(value) ? value : [value]).map((v) => ({ v, o: opts.find((o) => o.value === v) }));
        const absent = picked.find((x) => !x.o);
        if (absent) { ask({ key, why: "not_an_option", detail: `${show(absent.v)} is not one of the options`, read: value, candidates: [] }); continue; }
        const ruled = picked.find((x) => x.o!.unavailable);
        if (ruled) { ask({ key, why: "unavailable", detail: ruled.o!.unavailable!, read: value, candidates: [] }); continue; }
      }
    }
    if (p.domain?.kind === "range" && typeof value === "number" && (value < p.domain.min || value > p.domain.max)) {
      ask({ key, why: "out_of_range", detail: `${p.domain.min}–${p.domain.max}`, read: value, candidates: [] });
      continue;
    }
    set[key] = value;
    sources[key] = source;
  }

  const patch: Plan["patch"] = { set };
  if (x.batches?.qtys.length && canon(x.batches.qtys) !== canon(view.batches)) {
    if (canon(view.batches) === canon(def.batchDefaults)) {
      patch.batches = x.batches.qtys;
      sources.batches = x.batches.source;
    } else ask({ key: "batches", why: "differs", detail: `The configuration prices ${view.batches.join(", ")}; read ${x.batches.qtys.join(", ")}`, read: x.batches.qtys, candidates: [view.batches, x.batches.qtys] });
  }

  const declared = new Set((def.tables ?? []).map((t) => t.key));
  for (const t of x.tables) {
    if (!declared.has(t.table) || !t.rows.length) continue;
    const rows = t.rows.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)));
    if (view.tables[t.table]?.length) {
      if (canon(view.tables[t.table]) !== canon(rows))
        ask({ key: t.table, why: "differs", detail: `The table already has ${view.tables[t.table]!.length} rows; read ${rows.length}`, read: rows, candidates: [] });
      continue;
    }
    (patch.tables ??= {})[t.table] = rows;
    sources[t.table] = t.source;
  }

  for (const u of x.unsure) ask({ key: u.key, why: "unsure", detail: u.why, candidates: u.candidates });
  return { patch, sources, questions, notes: x.notes };
}
