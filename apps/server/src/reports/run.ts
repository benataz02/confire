import { ORPCError } from "@orpc/server";
import { B1Error, countOf, followPages, readPages, type B1EntitySchema, type B1Transport } from "@confire/b1";
import type { Dataset, FilterCond, ReportDef } from "@confire/db";
import { tenantConnector, tenantCurrency } from "../b1.ts";
import { entityList, entitySchema } from "../entity-meta.ts";
import { compileAggregate, compileLinesAggregate, compileLinesRows, compileList, flattenJoined } from "../entity-list.ts";
import { evaluate, toParts, withDerived, type PartRow, type TableData } from "./aggregate.ts";
import { readConfire } from "./confire.ts";
import { resolveFilter } from "./dates.ts";
import { planReads, rootField, sourceLabel, SOURCE, type Read } from "./plan.ts";
import type { DatasetStat, ReportResult } from "./types.ts";
import { checkReport } from "./validate.ts";

// Running a report (reports spec §3.3): validate the whole definition, ask SAP for the totals
// (`$apply`, every page followed), fall back to reading rows where SAP refuses, attach the lookups,
// read the tables' rows, and compute every figure (aggregate.ts). Nothing here trusts the model.

const PAGE = 500;
/** 20,000 rows per read; past it the dataset is `partial` and the page says so. */
const MAX_PAGES = 40;
const TABLE_ROWS = 2_000;
const TABLE_PAGES = TABLE_ROWS / PAGE;
/** Keys per lookup read: an OR of `eq`s, kept well inside the Service Layer's URL length. */
const LOOKUP_BATCH = 50;
const CONFIRE_CAP = MAX_PAGES * PAGE;

type Rows = Record<string, unknown>[];

/** Where a run reads from: the tenant's SAP (null when none is paired), its schemas (null = no such
 *  set), and Confire's own rows. Injected, so the runner is tested without an agent. */
export type Sources = {
  b1: B1Transport | null;
  company: string | null;
  currency: string | null;
  schema: (entity: string) => Promise<B1EntitySchema | null>;
  confire: (entity: string, filter: FilterCond[], select: string[], cap: number) => Promise<{ rows: Rows; total: number }>;
};

/** Every problem with a definition, one per line: the chat's refusal, which it corrects in one turn. */
export class ReportInvalid extends Error {
  constructor(readonly problems: string[]) {
    super(`Not built — fix these and call report_set again:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    this.name = "ReportInvalid";
  }
}

const fieldsOf = (r: Read): string[] => [...new Set([...r.agg.groupBy, ...r.agg.measures.flatMap((m) => (m.field ? [m.field] : []))])];
const stripOrder = (row: PartRow) => Object.fromEntries(Object.entries(row).filter(([k]) => !k.endsWith("#order")));

export async function runWith(src: Sources, def: ReportDef, role: string, today: Date): Promise<ReportResult> {
  const entities = new Set<string>();
  for (const ds of Object.values(def.datasets)) {
    for (const s of ds.from) if (s.source === "b1") entities.add(s.entity);
    for (const l of ds.lookups) entities.add(l.entity);
  }
  const b1 = src.b1;
  if (entities.size && !b1) throw new ReportInvalid(["SAP is not connected to this workspace: only Confire's Configurations can be reported on"]);
  const schemas = new Map<string, B1EntitySchema | null>();
  for (const e of entities) schemas.set(e, await src.schema(e));
  const problems = checkReport(def, schemas, role);
  if (problems.length) throw new ReportInvalid(problems);

  const stats: Record<string, DatasetStat> = Object.fromEntries(Object.keys(def.datasets).map((k) => [k, { rows: 0, partial: null, fellBack: false }]));
  const fellBack = new Set<string>();
  const note = (id: string, n: number, partial: { read: number; total: number | null } | null) => {
    const st = stats[id]!;
    st.rows += n;
    if (partial && (!st.partial || partial.read > st.partial.read)) st.partial = partial;
  };

  /** Rows of a source, every page up to `maxPages`; the total from `$count` where B1 gives one. */
  const readRows = async (entity: string, lines: boolean, filter: FilterCond[], fields: string[], orderby: { field: string; dir: "asc" | "desc" }[], maxPages: number) => {
    const schema = schemas.get(entity)!;
    if (lines) {
      const first = await b1!.crossJoin(compileLinesRows(schema, entity, filter, fields, { pageSize: PAGE }));
      const { rows, truncated } = await followPages(b1!, first, { pageSize: PAGE, maxPages });
      return { rows: rows.map((r) => flattenJoined(r, entity)), truncated, total: null as number | null };
    }
    const own = fields.filter((n) => schema.fields.some((f) => f.name === n));
    const q = compileList(schema, { select: own.length ? own : schema.keys, filter, orderby }, { pageSize: PAGE, count: true });
    const first = await b1!.readEntitySet(entity, q);
    const { rows, truncated } = await followPages(b1!, first, { pageSize: PAGE, maxPages });
    return { rows, truncated, total: countOf(first.data) ?? null };
  };

  const totalsOf = async (r: Read): Promise<PartRow[]> => {
    const ds = def.datasets[r.dataset]!;
    const s = ds.from[r.source]!;
    if (s.source === "confire") {
      const { rows, total } = await src.confire(s.entity, r.filter, fieldsOf(r), CONFIRE_CAP);
      note(r.dataset, rows.length, total > rows.length ? { read: rows.length, total } : null);
      return toParts(rows, r.agg);
    }
    const schema = schemas.get(s.entity)!;
    try {
      const first = ds.lines
        ? await b1!.crossJoin(compileLinesAggregate(schema, s.entity, r.filter, r.agg, { pageSize: PAGE }))
        : await b1!.readEntitySet(s.entity, compileAggregate(schema, r.filter, r.agg, { pageSize: PAGE }));
      const { rows, truncated } = await followPages(b1!, first, { pageSize: PAGE, maxPages: MAX_PAGES });
      note(r.dataset, rows.length, truncated ? { read: rows.length, total: null } : null);
      return ds.lines ? rows.map((x) => flattenJoined(x, s.entity)) : rows;
    } catch (e) {
      // Only B1 refusing the `$apply` itself falls back; an agent that is down is the run's error.
      if (!(e instanceof B1Error) || e.status !== 400) throw e;
    }
    // ponytail: the slow path — every row read and totalled here, capped. Kept for the B1 versions and
    // sets `$apply` does not cover (unverified on a live B1, reports spec §3.3).
    stats[r.dataset]!.fellBack = true;
    fellBack.add(s.entity);
    const { rows, truncated, total } = await readRows(s.entity, ds.lines, r.filter, fieldsOf(r), [], MAX_PAGES);
    note(r.dataset, rows.length, truncated ? { read: rows.length, total } : null);
    return toParts(rows, r.agg);
  };

  const plan = planReads(def, today);
  const data = new Map<string, PartRow[]>();
  // ponytail: sequential; parallel once a live agent is shown to take concurrent requests on one SAP session.
  for (const r of plan.reads) data.set(r.key, await totalsOf(r));

  const tableRows = new Map<number, { rows: Rows; total: number | null; partial: boolean }>();
  for (const [wi, w] of def.widgets.entries()) {
    if (w.kind !== "table") continue;
    const ds = def.datasets[w.dataset]!;
    const raw = [...new Set([...w.columns, ...w.groupBy, ...w.sortBy.map((s) => s.field)]
      .map((n) => rootField(ds, n)).filter((n): n is string => !!n))];
    const orderby = w.sortBy.filter((s) => rootField(ds, s.field) === s.field);
    const all: Rows = [];
    let total: number | null = 0;
    let partial = false;
    for (const [i, s] of ds.from.entries()) {
      const filter = resolveFilter([...ds.filter, ...s.filter], today);
      const got = s.source === "confire"
        ? await src.confire(s.entity, filter, raw, TABLE_ROWS).then((x) => ({ rows: x.rows, truncated: x.total > x.rows.length, total: x.total as number | null }))
        : await readRows(s.entity, ds.lines, filter, raw, s.source === "b1" ? orderby.filter((o) => !o.field.startsWith("Lines.") || ds.lines) : [], TABLE_PAGES);
      partial ||= got.truncated;
      total = total === null || got.total === null ? null : total + got.total;
      all.push(...got.rows.map((x) => ({ ...x, [SOURCE]: sourceLabel(ds, i), _entity: s.entity })));
    }
    tableRows.set(wi, { rows: all, total, partial });
  }

  // Lookups, per dataset, over its totals and its tables' rows alike: each a batched read of the keys
  // its rows hold, in declaration order, so a lookup may stand on an earlier one.
  for (const [id, ds] of Object.entries(def.datasets)) {
    if (!ds.lookups.length) continue;
    const rows: PartRow[] = [
      ...plan.reads.filter((r) => r.dataset === id).flatMap((r) => data.get(r.key) ?? []),
      ...def.widgets.flatMap((w, wi) => (w.kind === "table" && w.dataset === id ? tableRows.get(wi)?.rows ?? [] : [])),
    ];
    for (const l of ds.lookups) await attachLookup(b1!, schemas.get(l.entity)!, l, rows);
  }

  const tables = new Map<number, TableData>();
  for (const [wi, t] of tableRows) {
    const w = def.widgets[wi]!;
    if (w.kind !== "table") continue;
    const ds = def.datasets[w.dataset]!;
    const rows = t.rows.map((r) => stripOrder(withDerived(r, ds, today)));
    sortRows(rows, w.sortBy);
    tables.set(wi, { rows: rows.slice(0, TABLE_ROWS), total: t.total, partial: t.partial || rows.length > TABLE_ROWS });
  }

  const warnings = [
    ...Object.entries(stats).flatMap(([id, st]) => st.partial
      ? [`Dataset ${id}: only the first ${st.partial.read} rows of ${st.partial.total ?? "more"} were read, so its figures are partial.`] : []),
    ...[...fellBack].map((e) => `${e}: SAP did not total it itself, so its rows were read and totalled here (slower, at most ${MAX_PAGES * PAGE} rows).`),
  ];
  return {
    readAt: today.toISOString(), company: src.company, currency: src.currency,
    datasets: stats, widgets: evaluate(def, plan, data, tables, today), warnings,
  };
}

async function attachLookup(b1: B1Transport, schema: B1EntitySchema, l: Dataset["lookups"][number], rows: PartRow[]): Promise<void> {
  const keys = [...new Set(rows.map((r) => r[l.field]).filter((v): v is string | number => typeof v === "string" ? v !== "" : typeof v === "number"))];
  const found = new Map<string, unknown>();
  for (let i = 0; i < keys.length; i += LOOKUP_BATCH) {
    const q = compileList(schema, { select: [l.key, l.value], filter: [{ field: l.key, op: "in", value: keys.slice(i, i + LOOKUP_BATCH) }], orderby: [] }, { pageSize: PAGE });
    const { rows: got } = await readPages(b1, l.entity, q, { maxPages: 1 });
    for (const g of got) found.set(String(g[l.key]), g[l.value]);
  }
  for (const r of rows) r[l.name] = found.get(String(r[l.field])) ?? null;
}

function sortRows(rows: Rows, by: { field: string; dir: "asc" | "desc" }[]): void {
  if (!by.length) return;
  rows.sort((a, b) => {
    for (const s of by) {
      const x = a[s.field], y = b[s.field];
      const c = typeof x === "number" && typeof y === "number" ? x - y
        : String(x ?? "").localeCompare(String(y ?? ""), undefined, { numeric: true });
      if (c) return s.dir === "desc" ? -c : c;
    }
    return 0;
  });
}

/** A run for the tenant: its agent (none paired = Confire-only), the cached schemas, Confire's rows. */
export async function runReport(ctx: { tenantId: string; role: string }, def: ReportDef, today = new Date()): Promise<ReportResult> {
  const conn = await tenantConnector(ctx.tenantId).catch((e: unknown) => {
    if (e instanceof ORPCError && e.code === "SERVICE_UNAVAILABLE") return null;
    throw e;
  });
  let names: Set<string> | null = null;
  const src: Sources = {
    b1: conn?.b1 ?? null,
    company: conn?.companyDb ?? null,
    currency: conn ? await tenantCurrency(ctx.tenantId) : null,
    schema: async (entity) => {
      names ??= new Set((await entityList(ctx.tenantId, conn!.b1)).map((e) => e.name));
      return names.has(entity) ? entitySchema(ctx.tenantId, conn!.b1, entity) : null;
    },
    confire: (entity, filter, select, cap) => readConfire(ctx.tenantId, entity, filter, select, cap),
  };
  return runWith(src, def, ctx.role, today);
}
