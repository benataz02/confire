import { type Ast, assertCallArity, DslError, parse } from "./dsl";
import { aggregateKey, derivedKey, historyFields, historyKey, type LookupRef, type ModelDef, type TableDef, derivedColumns, refKeyCols, COST_COL, PRICE_COL, QTY_COL, OPERATION_VARS } from "./model";

export type Issue = { path: string; message: string; from?: number; to?: number };

export type KnownTable = { name: string; columns: string[] };

export const FUNCS = new Set(["IF", "MIN", "MAX", "ROUND", "CEIL", "FLOOR", "ABS", "CONCAT", "HAS", "LOOKUP", "ISBLANK", "SELECTED"]);

/** DocumentLine fields an items table may not map a column to: the price split owns them. */
export const RESERVED_LINE_FIELDS = new Set(["ItemCode", "Quantity", "UnitPrice", "LineNum"]);

/** Column keys an items table may not declare: the grid renders a runtime column under each, and
 *  a declared one of the same name would be shadowed by it (or shadow it) with no way to tell. */
const RESERVED_ITEM_COLS = new Set([COST_COL, PRICE_COL]);

/** Scalars a table contributes to every expression scope. */
export function aggregateKeysOf(t: TableDef): string[] {
  return [
    aggregateKey(t.key, "count"),
    ...t.columns.filter((c) => c.type === "number").map((c) => aggregateKey(t.key, c.key)),
  ];
}

type Ref = { name: string; from: number; to: number; kind: "ident" | "call" };

function collectRefs(n: Ast, out: Ref[]): void {
  switch (n.t) {
    case "lit":
      return;
    case "ident":
      out.push({ name: n.name, from: n.from, to: n.to, kind: "ident" });
      return;
    case "un":
      collectRefs(n.e, out);
      return;
    case "bin":
      collectRefs(n.l, out);
      collectRefs(n.r, out);
      return;
    case "tern":
      collectRefs(n.c, out);
      collectRefs(n.a, out);
      collectRefs(n.b, out);
      return;
    case "call":
      // Before the arguments: a bad arity is why the formula cannot run, and evaluate throws
      // the same error. Caught by checkExpr, so the editor shows it instead of saving a blank.
      assertCallArity(n);
      out.push({ name: n.name, from: n.from, to: n.to, kind: "call" });
      for (const a of n.args) collectRefs(a, out);
      return;
  }
}

export function checkModel(model: ModelDef, knownTables: KnownTable[] = []): Issue[] {
  const issues: Issue[] = [];
  const paramKeys = model.parameters.map((p) => p.key);
  const computedKeys = model.computed.map((c) => c.key);

  const seen = new Set<string>();
  for (const k of [...paramKeys, ...computedKeys]) {
    if (seen.has(k)) issues.push({ path: "model", message: `duplicate key '${k}'` });
    seen.add(k);
  }

  // lookup refs: masterdata names, columns, and the derived keys they add to scope
  const tableCols = new Map<string, string[]>(knownTables.map((t) => [t.name, t.columns] as const));
  const derived: string[] = [];
  const baseKeys = new Set([...paramKeys, ...computedKeys]);
  model.parameters.forEach((p, i) => {
    const ref = p.domain?.kind === "options" ? p.domain.ref : undefined;
    if (!ref || ref.source === "manual") return;
    const cols = tableCols.get(ref.table);
    if (!cols) {
      issues.push({ path: `parameters[${i}].domain`, message: `unknown table '${ref.table}'` });
      return;
    }
    const { valueCol, labelCol } = refKeyCols(ref, cols);
    if (!valueCol) issues.push({ path: `parameters[${i}].domain`, message: `table '${ref.table}' declares no columns` });
    for (const c of [...(valueCol ? [valueCol] : []), ...(labelCol ? [labelCol] : []), ...(ref.columns ?? []), ...(ref.where ? [ref.where.col] : [])]) {
      if (!cols.includes(c)) issues.push({ path: `parameters[${i}].domain`, message: `table '${ref.table}' has no column '${c}'` });
    }
    for (const col of derivedColumns(ref, cols)) {
      const dk = derivedKey(p.key, col);
      if (baseKeys.has(dk)) issues.push({ path: "model", message: `derived value '${dk}' collides with an existing key` });
      baseKeys.add(dk);
      derived.push(dk);
    }
  });

  // tables: keys, columns and the aggregates they add to scope. Same treatment as derived keys —
  // an aggregate that shadows a parameter would silently win in every formula.
  const tableDefs = model.tables ?? [];
  const aggregates: string[] = [];
  const seenTable = new Set<string>();
  tableDefs.forEach((t, i) => {
    if (seenTable.has(t.key)) issues.push({ path: `tables[${i}]`, message: `Another table is already called '${t.key}'.` });
    seenTable.add(t.key);
    if (baseKeys.has(t.key)) issues.push({ path: `tables[${i}]`, message: `A parameter or computed value is already called '${t.key}'.` });
    const cols = new Set<string>();
    t.columns.forEach((c, j) => {
      if (cols.has(c.key)) issues.push({ path: `tables[${i}].columns[${j}]`, message: `Another field in this table is already called '${c.key}'.` });
      cols.add(c.key);
      if (c.key === "count")
        issues.push({ path: `tables[${i}].columns[${j}]`, message: `'count' is taken: formulas read ${aggregateKey(t.key, "count")} as the number of rows.` });
    });
    for (const name of aggregateKeysOf(t)) {
      if (baseKeys.has(name)) issues.push({ path: `tables[${i}]`, message: `Formulas would get '${name}' from this table, but that name is already taken — rename the table or the field.` });
      baseKeys.add(name);
      aggregates.push(name);
    }
  });
  if (tableDefs.filter((t) => t.role === "items").length > 1)
    issues.push({ path: "tables", message: "at most one items table per model" });
  // Not optional: without it a quote falls back to one generic line per candidate, which no
  // Crystal layout and no downstream production step is built to read.
  if (!tableDefs.some((t) => t.role === "items"))
    issues.push({ path: "tables", message: "a model needs an items table — it is what becomes the quotation lines" });

  const derivedSet = new Set(derived);
  const base = new Set([...paramKeys, ...computedKeys, ...derived, ...aggregates]);
  const withQty = new Set([...base, "qty"]);
  // A linked routing line's figures may read its operation's catalog figures; its condition may
  // not — the operation has to be known before its figures are.
  const withOps = new Set([...withQty, ...OPERATION_VARS]);

  const checkExpr = (src: string | undefined, path: string, allowed: Set<string>) => {
    if (src === undefined) return;
    try {
      const refs: Ref[] = [];
      collectRefs(parse(src), refs);
      for (const r of refs) {
        if (r.kind === "call") {
          if (!FUNCS.has(r.name)) issues.push({ path, message: `unknown function '${r.name}'`, from: r.from, to: r.to });
        } else if (!allowed.has(r.name)) {
          issues.push({ path, message: `unknown identifier '${r.name}'`, from: r.from, to: r.to });
        }
      }
    } catch (e) {
      if (!(e instanceof DslError)) throw e;
      issues.push({ path, message: e.message, from: e.from, to: e.to });
    }
  };

  model.parameters.forEach((p, i) => {
    // A multi-select default is comma-separated option keys, not a formula (propagate splits them).
    if (p.ui !== "multicombo") checkExpr(p.defaultExpr, `parameters[${i}].defaultExpr`, base);
    checkExpr(p.visibleWhen, `parameters[${i}].visibleWhen`, base);
    checkExpr(p.requiredWhen, `parameters[${i}].requiredWhen`, base);
    // base, not withQty: the cost is per unit and the badge shows before any batch exists.
    checkExpr(p.priceExpr, `parameters[${i}].priceExpr`, base);
  });
  model.computed.forEach((c, i) => checkExpr(c.expr, `computed[${i}].expr`, base));
  model.constraints.forEach((c, i) => {
    if (c.kind === "expr") {
      checkExpr(c.when, `constraints[${i}].when`, base);
      checkExpr(c.assert, `constraints[${i}].assert`, base);
      // The message is all the user is told when the rule bites — inline and in the message list.
      if (!c.message.trim())
        issues.push({ path: `constraints[${i}].message`, message: "Say what the user is told when this rule is broken" });
    } else {
      c.params.forEach((pk, j) => {
        const p = model.parameters.find((x) => x.key === pk);
        if (!p) issues.push({ path: `constraints[${i}].params[${j}]`, message: `unknown parameter '${pk}'` });
        else if (p.excludeFromDomains)
          issues.push({ path: `constraints[${i}].params[${j}]`, message: `'${pk}' is excluded from engine domains` });
        else if (p.domain?.kind !== "options" && p.type !== "boolean")
          issues.push({ path: `constraints[${i}].params[${j}]`, message: `'${pk}' has no options domain` });
      });
      c.rows.forEach((row, j) => {
        if (row.length !== c.params.length)
          issues.push({ path: `constraints[${i}].rows[${j}]`, message: `row arity ${row.length} != ${c.params.length} values` });
      });
    }
  });
  model.bom.forEach((l, i) => {
    checkExpr(l.itemCode, `bom[${i}].itemCode`, withQty);
    checkExpr(l.desc, `bom[${i}].desc`, withQty);
    checkExpr(l.condition, `bom[${i}].condition`, withQty);
    checkExpr(l.qty, `bom[${i}].qty`, withQty);
  });
  model.routing.forEach((o, i) => {
    const figures = o.operationId === undefined ? withQty : withOps;
    checkExpr(o.operationId, `routing[${i}].operationId`, withQty);
    checkExpr(o.condition, `routing[${i}].condition`, withQty);
    checkExpr(o.setupMin, `routing[${i}].setupMin`, figures);
    checkExpr(o.runMinPerUnit, `routing[${i}].runMinPerUnit`, figures);
    checkExpr(o.ratePerHour, `routing[${i}].ratePerHour`, figures);
  });
  // 100% would divide the cost by zero; below 0 is selling under cost by design, which no shop sets
  // as its default.
  if (!(model.pricing.margin >= 0 && model.pricing.margin < 100))
    issues.push({ path: "pricing.margin", message: "the margin is a share of the price: at least 0% and under 100%" });
  // Mandatory, not optional: a BOM line carries no price of its own any more, so without a price
  // list every material costs an unanswerable question.
  if (!model.pricing.priceList)
    issues.push({ path: "pricing.priceList", message: "a model needs a price list — it is what prices the BOM materials" });
  // The price list says WHICH price; the item table says where the prices are cached. A BOM
  // without one cannot be costed at all, so it is refused at save rather than at calculate.
  if (model.bom.length && !model.pricing.itemTable)
    issues.push({ path: "pricing.itemTable", message: "a model with a BOM needs an item masterdata query — it is where the prices are read from" });
  else if (model.pricing.itemTable && !tableCols.has(model.pricing.itemTable))
    issues.push({ path: "pricing.itemTable", message: `unknown table '${model.pricing.itemTable}'` });
  // The same pair for the routing: a linked line's figures are read from this query's cache.
  if (model.routing.some((o) => o.operationId !== undefined) && !model.pricing.operationTable)
    issues.push({ path: "pricing.operationTable", message: "a routing line linked to a Beas operation needs an operations masterdata query" });
  else if (model.pricing.operationTable && !tableCols.has(model.pricing.operationTable))
    issues.push({ path: "pricing.operationTable", message: `unknown table '${model.pricing.operationTable}'` });

  // computed dependency cycles (computed -> computed edges only)
  const compSet = new Set(computedKeys);
  const deps = new Map<string, string[]>();
  for (const c of model.computed) {
    try {
      const refs: Ref[] = [];
      collectRefs(parse(c.expr), refs);
      deps.set(c.key, refs.filter((r) => r.kind === "ident" && compSet.has(r.name)).map((r) => r.name));
    } catch {
      deps.set(c.key, []); // parse error already reported
    }
  }
  const state = new Map<string, 1 | 2>(); // 1=visiting 2=done
  const visit = (k: string, path: string[]): void => {
    if (state.get(k) === 2) return;
    if (state.get(k) === 1) {
      issues.push({ path: "computed", message: `dependency cycle: ${[...path, k].join(" -> ")}` });
      return;
    }
    state.set(k, 1);
    for (const d of deps.get(k) ?? []) visit(d, [...path, k]);
    state.set(k, 2);
  };
  for (const k of computedKeys) visit(k, []);

  // A hidden section's or group's tables count no rows, and the items grid's rows are the quotation's lines.
  const itemsKey = tableDefs.find((t) => t.role === "items")?.key;
  const holdsItems = (g: { params: string[] }) => itemsKey !== undefined && g.params.includes(itemsKey);
  model.structure.sections.forEach((s, i) => {
    checkExpr(s.visibleWhen, `structure.sections[${i}].visibleWhen`, base);
    if (s.visibleWhen !== undefined && s.groups.some(holdsItems))
      issues.push({ path: `structure.sections[${i}].visibleWhen`, message: "This section holds the item grid, which is always shown — move the grid or put the rule on its groups." });
    s.groups.forEach((g, j) => {
      checkExpr(g.visibleWhen, `structure.sections[${i}].groups[${j}].visibleWhen`, base);
      if (g.visibleWhen !== undefined && holdsItems(g))
        issues.push({ path: `structure.sections[${i}].groups[${j}].visibleWhen`, message: "This group holds the item grid, which is always shown — move the grid or put the rule on its fields." });
    });
  });

  // structure references: a group's key is a parameter's or a table's, each placed once.
  const seenPlaced = new Set<string>();
  for (const g of model.structure.sections.flatMap((s) => s.groups))
    for (const k of g.params) {
      if (seenTable.has(k)) {
        if (seenPlaced.has(k)) issues.push({ path: "structure", message: `table '${k}' is placed more than once` });
        seenPlaced.add(k);
      } else if (!base.has(k) || compSet.has(k) || derivedSet.has(k))
        issues.push({ path: "structure", message: `structure references unknown parameter '${k}'` });
    }

  // LOOKUP table names when statically known (first arg is a string literal)
  const tables = new Set(knownTables.map((t) => t.name));
  const checkLookups = (src: string, path: string) => {
    for (const n of nodesOf(src)) {
      const l = lookupTable(n);
      if (l && !tables.has(l.name)) issues.push({ path, message: `unknown table '${l.name}'`, from: l.from, to: l.to });
    }
  };
  model.routing.forEach((o, i) => checkLookups(o.ratePerHour, `routing[${i}].ratePerHour`));

  tableDefs.forEach((t, i) => {
    // a cell formula sees the model scope plus its own row's earlier columns. Columns join the
    // allowed set only after their own check, so a forward reference reads as unknown — which is
    // exactly the rule, since evalTableRows evaluates in declaration order.
    const inRow = new Set(base);
    t.columns.forEach((c, j) => {
      const path = `tables[${i}].columns[${j}].cell`;
      if (c.cell.kind === "formula") {
        checkExpr(c.cell.expr, path, inRow);
        checkLookups(c.cell.expr, path);
      } else if (c.cell.kind === "options" && c.cell.ref.source !== "manual") {
        const ref = c.cell.ref;
        const srcCols = tableCols.get(ref.table);
        if (!srcCols) issues.push({ path, message: `The masterdata '${ref.table}' no longer exists — pick another source.` });
        else {
          const { valueCol, labelCol } = refKeyCols(ref, srcCols);
          if (!valueCol) issues.push({ path, message: `The masterdata '${ref.table}' has no columns to pick from.` });
          for (const col of [...(valueCol ? [valueCol] : []), ...(labelCol ? [labelCol] : []), ...(ref.where ? [ref.where.col] : [])])
            if (!srcCols.includes(col)) issues.push({ path, message: `The masterdata '${ref.table}' has no column '${col}'.` });
          // the picked row's other columns, in row scope as <column>_<source column> — the same
          // rule a parameter's options domain gets, and bound by the same declaration order.
          for (const col of derivedColumns(ref, srcCols)) inRow.add(derivedKey(c.key, col));
        }
      }
      inRow.add(c.key);
    });
    if (t.role !== "items") return;
    // The basis sees the whole row, so it is checked once the loop above has admitted every column.
    checkExpr(t.basisExpr, `tables[${i}].basisExpr`, inRow);
    checkLookups(t.basisExpr, `tables[${i}].basisExpr`);
    const declared = new Set(t.columns.map((c) => c.key));
    if (!t.columns.some((c) => c.key === QTY_COL && c.type === "number"))
      issues.push({ path: `tables[${i}]`, message: `The item grid needs a number field '${QTY_COL}' — it sets each line's quantity.` });
    t.columns.forEach((c, j) => {
      if (RESERVED_ITEM_COLS.has(c.key))
        issues.push({
          path: `tables[${i}].columns[${j}].key`,
          message: `The grid already shows each line's ${c.key} — pick another key.`,
        });
    });
    for (const [col, target] of Object.entries(t.map ?? {})) {
      if (!declared.has(col)) issues.push({ path: `tables[${i}].map`, message: `The B1 line mapping still names '${col}', which this grid no longer has.` });
      if (RESERVED_LINE_FIELDS.has(target))
        // per column, so the dialog can show it on that column's own field
        issues.push({ path: `tables[${i}].map.${col}`, message: `Confire fills ${target} from the price split — map this field to another one.` });
    }
  });

  // history: named masterdata exists, mapped params exist, closeness only on numbers,
  // columns ⊆ that table. The query itself lives in masterdata, not on the model.
  if (model.history) {
    const h = model.history;
    const fields = historyFields(model);
    if (h.mappings.length && !h.table)
      issues.push({ path: "history.table", message: "similarity mappings need a history query" });
    if (h.table && !tableCols.has(h.table))
      issues.push({ path: "history.table", message: `unknown table '${h.table}'` });
    const qCols = (h.table && tableCols.get(h.table)) ?? [];
    h.mappings.forEach((m, i) => {
      const key = historyKey(m), f = fields.get(key);
      if (!f) issues.push({ path: `history.mappings[${i}]`, message: `unknown parameter '${key}'` });
      else if (m.match === "closeness" && f.type !== "number")
        issues.push({ path: `history.mappings[${i}]`, message: `closeness needs a number parameter ('${key}' is ${f.type})` });
      if (qCols.length && !qCols.includes(m.column))
        issues.push({ path: `history.mappings[${i}]`, message: `query has no column '${m.column}'` });
    });
    h.display.forEach((c, i) => {
      if (qCols.length && !qCols.includes(c))
        issues.push({ path: `history.display[${i}]`, message: `query has no column '${c}'` });
    });
  }

  return issues;
}


/** Every masterdata table this model names as a *live lookup*: domain refs plus statically-known
   *  LOOKUP() first arguments. History's cache source is not included — sync fetches that query
   *  wholesale, and putting it here would pull it onto every calculate. The server fetches only
   *  these, so a tenant's other live queries cost nothing — a LOOKUP whose table name is computed
   *  at runtime cannot be seen here, which is why `checkModel` only accepts string literals there
   *  in the first place. */
export function referencedTables(model: ModelDef): Set<string> {
  const out = new Set<string>();
  for (const p of model.parameters) {
    const ref = p.domain?.kind === "options" ? p.domain.ref : undefined;
    if (ref && ref.source !== "manual") out.add(ref.table);
  }
  for (const t of model.tables ?? [])
    for (const c of t.columns)
      if (c.cell.kind === "options" && c.cell.ref.source !== "manual") out.add(c.cell.ref.table);
  for (const src of exprsOf(model))
    for (const n of nodesOf(src)) {
      const l = lookupTable(n);
      if (l) out.add(l.name);
    }
  return out;
}

/** Every masterdata query a SYNC has to keep fresh for this model: the live lookups above, plus
 *  the two cache sources `referencedTables` deliberately leaves out — the history query and the
 *  item/price query. Kept separate because those two are cache sources the form never pages.
 *
 *  This is the one place that knows the full set, which is what lets `masterdata.remove` stop
 *  guessing: before it, the delete guard had to re-add `history.table` by hand. */
export function syncTables(model: ModelDef): Set<string> {
  const out = referencedTables(model);
  if (model.history?.table) out.add(model.history.table);
  if (model.pricing.itemTable) out.add(model.pricing.itemTable);
  if (model.pricing.operationTable) out.add(model.pricing.operationTable);
  return out;
}

/** The item codes a resolve has to fetch a price for.
 *
 *  An `itemCode` is an expression, but the builder's value help writes a plain string literal, so
 *  in practice the literals in it ARE the codes. A bare identifier is the other shipped shape — a
 *  parameter that holds the code — and its resolved domain contributes every value it could take.
 *  Anything computed (`CONCAT(...)`, a `LOOKUP(...)`) is undecidable before evaluation: it yields
 *  nothing here, and the line then costs 0 in computeOutputs, flagged `unpriced` — the process
 *  page names every such item in its messages, so a free material is never a silent one. */
export function bomItemCodes(model: ModelDef, domains?: Record<string, { value: unknown }[]>): string[] {
  return codesOf(model.bom.map((l) => l.itemCode), domains, false);
}

/** The Beas operations a resolve has to read catalog figures for — `bomItemCodes`' rule over the
 *  routing lines' `operationId`. Trimmed: Beas pads its codes (char columns), and computeOutputs
 *  trims the evaluated code the same way. */
export function routingOperationIds(model: ModelDef, domains?: Record<string, { value: unknown }[]>): string[] {
  return codesOf(model.routing.flatMap((o) => (o.operationId === undefined ? [] : [o.operationId])), domains, true);
}

/** The string literals in each expression, plus every value a bare identifier's domain holds. */
function codesOf(exprs: string[], domains: Record<string, { value: unknown }[]> | undefined, trim: boolean): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    const code = typeof v === "string" ? (trim ? v.trim() : v) : "";
    if (code) out.add(code);
  };
  for (const src of exprs)
    for (const n of nodesOf(src)) {
      if (n.t === "lit") add(n.v);
      else if (n.t === "ident") for (const o of domains?.[n.name] ?? []) add(o.value);
    }
  return [...out];
}

/** Every node of an expression, depth first; none for one that does not parse (checkModel's problem). */
function nodesOf(src: string): Ast[] {
  let ast: Ast;
  try {
    ast = parse(src);
  } catch {
    return [];
  }
  const out: Ast[] = [];
  const walk = (n: Ast): void => {
    out.push(n);
    if (n.t === "call") n.args.forEach(walk);
    else if (n.t === "un") walk(n.e);
    else if (n.t === "bin") { walk(n.l); walk(n.r); }
    else if (n.t === "tern") { walk(n.c); walk(n.a); walk(n.b); }
  };
  walk(ast);
  return out;
}

/** A LOOKUP's table when it is statically known (its first argument a string literal), with that
 *  literal's span, quotes included: what a message points at and what a rename rewrites. */
function lookupTable(n: Ast): { name: string; from: number; to: number } | undefined {
  if (n.t !== "call" || n.name !== "LOOKUP") return undefined;
  const a = n.args[0];
  return a?.t === "lit" && typeof a.v === "string" ? { name: a.v, from: a.from, to: a.to } : undefined;
}

/** The model with every expression passed through `fn`, everything else as it was. The one list of
 *  where a model keeps expressions: `exprsOf` reads it and `renameTable` rewrites through it, so a
 *  new expression field added here is seen by both. It must include cell formulas and `basisExpr`,
 *  or referencedTables misses the masterdata a LOOKUP() there needs and it fails at runtime with
 *  "unknown table" while checkModel reports nothing. */
function mapExprs(model: ModelDef, fn: (e: string) => string): ModelDef {
  const over = <T extends object>(o: T, keys: readonly (keyof T)[]): T => {
    const r = { ...o };
    for (const k of keys) if (typeof r[k] === "string") (r as Record<keyof T, unknown>)[k] = fn(r[k] as string);
    return r;
  };
  return {
    ...model,
    parameters: model.parameters.map((p) => over(p, ["defaultExpr", "visibleWhen", "requiredWhen", "priceExpr"])),
    computed: model.computed.map((c) => over(c, ["expr"])),
    structure: {
      ...model.structure,
      sections: model.structure.sections.map((s) => ({ ...over(s, ["visibleWhen"]), groups: s.groups.map((g) => over(g, ["visibleWhen"])) })),
    },
    constraints: model.constraints.map((c) => (c.kind === "expr" ? over(c, ["when", "assert"]) : c)),
    bom: model.bom.map((l) => over(l, ["itemCode", "condition", "qty"])),
    routing: model.routing.map((o) => over(o, ["operationId", "condition", "setupMin", "runMinPerUnit", "ratePerHour"])),
    ...(model.tables
      ? {
          tables: model.tables.map((t): TableDef => ({
            ...(t.role === "items" ? over(t, ["basisExpr"]) : t),
            columns: t.columns.map((c) => (c.cell.kind === "formula" ? { ...c, cell: { ...c.cell, expr: fn(c.cell.expr) } } : c)),
          })),
        }
      : {}),
  };
}

/** A masterdata rename carried into a model: every place `syncTables` reads a table name from — a
 *  domain or cell ref, a LOOKUP's literal table argument, the history and pricing queries — and
 *  nowhere else (the same text as a LOOKUP key or another argument is a value, not the table). */
export function renameTable(model: ModelDef, from: string, to: string): ModelDef {
  const ref = (r: LookupRef): LookupRef => (r.source !== "manual" && r.table === from ? { ...r, table: to } : r);
  const expr = (src: string) =>
    nodesOf(src)
      .map(lookupTable)
      .filter((l): l is NonNullable<typeof l> => l?.name === from)
      // right to left, so an earlier span keeps its offsets
      .sort((a, b) => b.from - a.from)
      // quoted as is, not JSON.stringify: the DSL's strings have no escapes
      .reduce((s, l) => `${s.slice(0, l.from)}"${to}"${s.slice(l.to)}`, src);
  const m = mapExprs(model, expr);
  return {
    ...m,
    parameters: m.parameters.map((p) => (p.domain?.kind === "options" ? { ...p, domain: { ...p.domain, ref: ref(p.domain.ref) } } : p)),
    ...(m.tables
      ? {
          tables: m.tables.map((t): TableDef => ({
            ...t,
            columns: t.columns.map((c) => (c.cell.kind === "options" ? { ...c, cell: { ...c.cell, ref: ref(c.cell.ref) } } : c)),
          })),
        }
      : {}),
    ...(m.history?.table === from ? { history: { ...m.history, table: to } } : {}),
    pricing: {
      ...m.pricing,
      ...(m.pricing.itemTable === from ? { itemTable: to } : {}),
      ...(m.pricing.operationTable === from ? { operationTable: to } : {}),
    },
  };
}

/** Every expression string in a model. */
function exprsOf(model: ModelDef): string[] {
  const out: string[] = [];
  mapExprs(model, (e) => {
    out.push(e);
    return e;
  });
  return out;
}
