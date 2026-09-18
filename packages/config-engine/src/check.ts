import { type Ast, DslError, parse } from "./dsl";
import { aggregateKey, derivedKey, type ModelDef, type TableDef, derivedColumns, refKeyCols, isTableGroup, COST_COL, PRICE_COL, QTY_COL } from "./model";

export type Issue = { path: string; message: string; from?: number; to?: number };

export type KnownTable = { name: string; columns: string[] };

export const FUNCS = new Set(["IF", "MIN", "MAX", "ROUND", "CEIL", "FLOOR", "ABS", "CONCAT", "HAS", "LOOKUP"]);

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
    for (const c of [...(valueCol ? [valueCol] : []), ...(labelCol ? [labelCol] : []), ...(ref.columns ?? [])]) {
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
    if (seenTable.has(t.key)) issues.push({ path: `tables[${i}]`, message: `duplicate table '${t.key}'` });
    seenTable.add(t.key);
    if (baseKeys.has(t.key)) issues.push({ path: `tables[${i}]`, message: `table key '${t.key}' collides with an existing key` });
    const cols = new Set<string>();
    t.columns.forEach((c, j) => {
      if (cols.has(c.key)) issues.push({ path: `tables[${i}].columns[${j}]`, message: `duplicate column '${c.key}'` });
      cols.add(c.key);
      if (c.key === "count")
        issues.push({ path: `tables[${i}].columns[${j}]`, message: `'count' is reserved: it collides with '${aggregateKey(t.key, "count")}'` });
    });
    for (const name of aggregateKeysOf(t)) {
      if (baseKeys.has(name)) issues.push({ path: `tables[${i}]`, message: `aggregate '${name}' collides with an existing key` });
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
  const pricingScope = new Set([...withQty, "unitCost"]);

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
    checkExpr(p.defaultExpr, `parameters[${i}].defaultExpr`, base);
    checkExpr(p.visibleWhen, `parameters[${i}].visibleWhen`, base);
    checkExpr(p.requiredWhen, `parameters[${i}].requiredWhen`, base);
    // base, not pricingScope: the badge is per-unit and shown before any batch exists.
    checkExpr(p.priceExpr, `parameters[${i}].priceExpr`, base);
  });
  model.computed.forEach((c, i) => checkExpr(c.expr, `computed[${i}].expr`, base));
  model.constraints.forEach((c, i) => {
    if (c.kind === "expr") {
      checkExpr(c.when, `constraints[${i}].when`, base);
      checkExpr(c.assert, `constraints[${i}].assert`, base);
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
    checkExpr(l.condition, `bom[${i}].condition`, withQty);
    checkExpr(l.qty, `bom[${i}].qty`, withQty);
  });
  model.routing.forEach((o, i) => {
    checkExpr(o.condition, `routing[${i}].condition`, withQty);
    checkExpr(o.setupMin, `routing[${i}].setupMin`, withQty);
    checkExpr(o.runMinPerUnit, `routing[${i}].runMinPerUnit`, withQty);
    checkExpr(o.ratePerHour, `routing[${i}].ratePerHour`, withQty);
  });
  checkExpr(model.pricing.priceExpr, "pricing.priceExpr", pricingScope);
  // Mandatory, not optional: a BOM line carries no price of its own any more, so without a price
  // list every material costs an unanswerable question.
  if (!model.pricing.priceList)
    issues.push({ path: "pricing.priceList", message: "a model needs a price list — it is what prices the BOM materials" });

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

  // structure references. A group is either a table (naming one TableDef) or a list of parameter
  // keys — never both, so the two arms are checked separately.
  const seenPlaced = new Set<string>();
  for (const g of model.structure.sections.flatMap((s) => s.groups)) {
    if (isTableGroup(g)) {
      if (!seenTable.has(g.table)) issues.push({ path: "structure", message: `structure references unknown table '${g.table}'` });
      else if (seenPlaced.has(g.table)) issues.push({ path: "structure", message: `table '${g.table}' is placed more than once` });
      seenPlaced.add(g.table);
      continue;
    }
    for (const k of g.params) {
      // A table key here is a model saved before tables became groups: still not a parameter, and
      // placedTables() drops it, so the form's trailing catch-all section is what still shows it.
      if (seenTable.has(k)) issues.push({ path: "structure", message: `table '${k}' sits in group '${g.key}' — place it as a group of its own` });
      else if (!base.has(k) || compSet.has(k) || derivedSet.has(k))
        issues.push({ path: "structure", message: `structure references unknown parameter '${k}'` });
    }
  }

  // LOOKUP table names when statically known (first arg is a string literal)
  const tables = new Set(knownTables.map((t) => t.name));
  const checkLookups = (src: string | undefined, path: string) => {
    if (src === undefined) return;
    let ast: Ast;
    try {
      ast = parse(src);
    } catch {
      return;
    }
    const walk = (n: Ast): void => {
      if (n.t === "call") {
        if (n.name === "LOOKUP" && n.args[0]?.t === "lit" && typeof n.args[0].v === "string" && !tables.has(n.args[0].v))
          issues.push({ path, message: `unknown table '${n.args[0].v}'`, from: n.args[0].from, to: n.args[0].to });
        n.args.forEach(walk);
      } else if (n.t === "un") walk(n.e);
      else if (n.t === "bin") {
        walk(n.l);
        walk(n.r);
      } else if (n.t === "tern") {
        walk(n.c);
        walk(n.a);
        walk(n.b);
      }
    };
    walk(ast);
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
        if (!srcCols) issues.push({ path, message: `unknown table '${ref.table}'` });
        else {
          const { valueCol, labelCol } = refKeyCols(ref, srcCols);
          if (!valueCol) issues.push({ path, message: `table '${ref.table}' declares no columns` });
          for (const col of [...(valueCol ? [valueCol] : []), ...(labelCol ? [labelCol] : [])])
            if (!srcCols.includes(col)) issues.push({ path, message: `table '${ref.table}' has no column '${col}'` });
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
      issues.push({ path: `tables[${i}]`, message: `an items table needs a number column '${QTY_COL}'` });
    t.columns.forEach((c, j) => {
      if (RESERVED_ITEM_COLS.has(c.key))
        issues.push({
          path: `tables[${i}].columns[${j}].key`,
          message: `'${c.key}' is the grid's own cost/price column and cannot be declared`,
        });
    });
    for (const [col, target] of Object.entries(t.map ?? {})) {
      if (!declared.has(col)) issues.push({ path: `tables[${i}].map`, message: `unknown column '${col}'` });
      if (RESERVED_LINE_FIELDS.has(target))
        issues.push({ path: `tables[${i}].map`, message: `'${target}' is set by the price split and cannot be mapped` });
    }
  });

  // history: named masterdata exists, mapped params exist, closeness only on numbers,
  // columns ⊆ that table. The query itself lives in masterdata, not on the model.
  if (model.history) {
    const h = model.history;
    const paramOf = (k: string) => model.parameters.find((p) => p.key === k);
    if (h.mappings.length && !h.table)
      issues.push({ path: "history.table", message: "similarity mappings need a history query" });
    if (h.table && !tableCols.has(h.table))
      issues.push({ path: "history.table", message: `unknown table '${h.table}'` });
    const qCols = (h.table && tableCols.get(h.table)) ?? [];
    h.mappings.forEach((m, i) => {
      const p = paramOf(m.param);
      if (!p) issues.push({ path: `history.mappings[${i}]`, message: `unknown parameter '${m.param}'` });
      else if (m.match === "closeness" && p.type !== "number")
        issues.push({ path: `history.mappings[${i}]`, message: `closeness needs a number parameter ('${m.param}' is ${p.type})` });
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
  const walk = (n: Ast): void => {
    if (n.t === "call") {
      if (n.name === "LOOKUP" && n.args[0]?.t === "lit" && typeof n.args[0].v === "string") out.add(n.args[0].v);
      n.args.forEach(walk);
    } else if (n.t === "un") walk(n.e);
    else if (n.t === "bin") { walk(n.l); walk(n.r); }
    else if (n.t === "tern") { walk(n.c); walk(n.a); walk(n.b); }
  };
  for (const src of exprsOf(model)) {
    try {
      walk(parse(src));
    } catch {
      // an unparseable expression is checkModel's problem, not this one's
    }
  }
  return out;
}

/** The item codes a resolve has to fetch a price for.
 *
 *  An `itemCode` is an expression, but the builder's value help writes a plain string literal, so
 *  in practice the literals in it ARE the codes. A bare identifier is the other shipped shape — a
 *  parameter that holds the code — and its resolved domain contributes every value it could take.
 *  Anything computed (`CONCAT(...)`, a `LOOKUP(...)`) is undecidable before evaluation: it yields
 *  nothing here, and the line then fails in computeOutputs with "no price for item", which is the
 *  honest answer rather than a silently free material. */
export function bomItemCodes(model: ModelDef, domains?: Record<string, { value: unknown }[]>): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => { if (typeof v === "string" && v) out.add(v); };
  const walk = (n: Ast): void => {
    if (n.t === "lit") add(n.v);
    else if (n.t === "ident") for (const o of domains?.[n.name] ?? []) add(o.value);
    else if (n.t === "call") n.args.forEach(walk);
    else if (n.t === "un") walk(n.e);
    else if (n.t === "bin") { walk(n.l); walk(n.r); }
    else if (n.t === "tern") { walk(n.c); walk(n.a); walk(n.b); }
  };
  for (const l of model.bom) {
    try {
      walk(parse(l.itemCode));
    } catch {
      // an unparseable expression is checkModel's problem, not this one's
    }
  }
  return [...out];
}

/** Every expression string in a model, in no particular order. */
function* exprsOf(model: ModelDef): Generator<string> {
  for (const p of model.parameters)
    for (const e of [p.defaultExpr, p.visibleWhen, p.requiredWhen, p.priceExpr]) if (e) yield e;
  for (const c of model.computed) yield c.expr;
  for (const c of model.constraints) if (c.kind === "expr") { if (c.when) yield c.when; yield c.assert; }
  for (const l of model.bom) for (const e of [l.itemCode, l.condition, l.qty]) if (e) yield e;
  for (const o of model.routing)
    for (const e of [o.condition, o.setupMin, o.runMinPerUnit, o.ratePerHour]) if (e) yield e;
  // must include cell formulas, or referencedTables misses the masterdata a LOOKUP() there needs
  // and it fails at runtime with "unknown table" while checkModel reports nothing.
  for (const t of model.tables ?? [])
    for (const c of t.columns) if (c.cell.kind === "formula") yield c.cell.expr;
  yield model.pricing.priceExpr;
}
