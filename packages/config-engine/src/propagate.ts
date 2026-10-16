import { evaluate, parse } from "./dsl";
import type { Entries, ModelDef, Option, ResolvedLookups, TableRows, Val } from "./model";
import { derivedKey, derivedColumns, refKeyCols, requiredColumn } from "./model";
import { evalTableRows, tableAggregates } from "./tables";

export type Bindings = {
  values: Record<string, Val>;
  defaulted: Set<string>;
  visible: Record<string, boolean>;
};

export function domainOf(model: ModelDef, lookups: ResolvedLookups, key: string): Option[] {
  const p = model.parameters.find((x) => x.key === key);
  if (!p) return [];
  if (p.type === "boolean")
    return [
      { value: true, label: "Yes" },
      { value: false, label: "No" },
    ];
  if (p.domain?.kind === "options") return lookups.domains[key] ?? [];
  return [];
}

export function bindings(model: ModelDef, lookups: ResolvedLookups, entries: Entries, tableRows: TableRows = {}): Bindings {
  const values: Record<string, Val> = { ...entries };
  const defaulted = new Set<string>();
  const visible: Record<string, boolean> = {};
  const tryEval = (src: string): Val | undefined => {
    try {
      return evaluate(src, { vars: values, tables: lookups.tables });
    } catch {
      return undefined;
    }
  };

  const maxIter = model.parameters.length * 2 + model.computed.length + 2;
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (const p of model.parameters) {
      if (!(p.key in values) && p.defaultExpr !== undefined) {
        const v = tryEval(p.defaultExpr);
        if (v !== undefined) {
          values[p.key] = v;
          defaulted.add(p.key);
          changed = true;
        }
      }
    }
    for (const c of model.computed) {
      const v = tryEval(c.expr);
      if (v !== undefined && values[c.key] !== v) {
        values[c.key] = v;
        changed = true;
      }
    }
    // derived lookup columns: <param>_<col> from the selected value's source row
    for (const p of model.parameters) {
      const ref = p.domain?.kind === "options" ? p.domain.ref : undefined;
      if (!ref || ref.source === "manual" || !(p.key in values)) continue;
      const t = lookups.tables[ref.table];
      if (!t) continue;
      const vi = t.columns.indexOf(refKeyCols(ref, t.columns).valueCol);
      const row = vi < 0 ? undefined : t.rows.find((r) => r[vi] === values[p.key]);
      if (!row) continue; // unset/stale value: derived keys stay absent (undecidable, like unbound)
      for (const col of derivedColumns(ref, t.columns)) {
        const ci = t.columns.indexOf(col);
        const v = ci < 0 ? null : (row[ci] ?? null);
        const dk = derivedKey(p.key, col);
        if (values[dk] !== v) {
          values[dk] = v;
          changed = true;
        }
      }
    }
    // table aggregates: <table>_<col> and <table>_count. Inside the loop, like derived columns,
    // because a row formula can read a computed value and a computed value can read an aggregate.
    if (model.tables?.length) {
      for (const [k, v] of Object.entries(tableAggregates(model, tableRows, values, lookups))) {
        if (values[k] !== v) {
          values[k] = v;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  for (const p of model.parameters) {
    if (p.visibleWhen === undefined) {
      visible[p.key] = true;
      continue;
    }
    const v = tryEval(p.visibleWhen);
    visible[p.key] = v === undefined ? true : v === true;
  }
  return { values, defaulted, visible };
}

export type DomainOption = { value: Val; label: string; eliminatedBy?: string };
export type Propagation = {
  values: Record<string, Val>;
  defaulted: Set<string>;
  visible: Record<string, boolean>;
  /** `mandatory`, or `requiredWhen` holds — and visible: a hidden field is never required */
  required: Record<string, boolean>;
  domains: Record<string, DomainOption[]>;
  conflicts: { message: string; path: string }[];
  open: string[];
  candidateEstimate: number;
};

const live = (d: DomainOption[]) => d.filter((o) => !o.eliminatedBy);

export function propagate(
  model: ModelDef,
  lookups: ResolvedLookups,
  entries: Entries,
  tableRows: TableRows = {},
): Propagation {
  const b = bindings(model, lookups, entries, tableRows);
  const conflicts: Propagation["conflicts"] = [];
  const domains: Record<string, DomainOption[]> = {};
  for (const p of model.parameters) {
    if (p.excludeFromDomains) continue;
    const d = domainOf(model, lookups, p.key);
    if (d.length) domains[p.key] = d.map((o) => ({ ...o }));
    else if (p.key in lookups.domains) domains[p.key] = [];
  }
  const isBound = (k: string) => k in b.values;
  /** evaluate expr with a candidate binding merged in; recomputes defaults/computed */
  const evalWith = (src: string, extra: Entries): Val => {
    const v = bindings(model, lookups, { ...entries, ...extra }, tableRows).values;
    return evaluate(src, { vars: v, tables: lookups.tables });
  };

  for (let iter = 0; iter < 50; iter++) {
    let changed = false;
    const kill = (key: string, value: Val, by: string) => {
      const o = domains[key]?.find((x) => x.value === value && !x.eliminatedBy);
      if (o) {
        o.eliminatedBy = by;
        changed = true;
      }
    };

    model.constraints.forEach((c, ci) => {
      if (c.kind === "table") {
        const by = `combination table (${c.params.join(", ")})`;
        const unbound = c.params.filter((k) => !isBound(k) && domains[k]);
        const allBound = c.params.every(isBound);
        if (c.mode === "allow") {
          // rows compatible with bound values and live domains of other unbound params.
          // Domainless unbound params are wildcards — they do not reject a row.
          const rowOk = (row: Val[]) =>
            c.params.every((k, i) =>
              isBound(k) ? b.values[k] === row[i]
              : !domains[k] || live(domains[k]).some((o) => o.value === row[i]),
            );
          const kept = c.rows.filter(rowOk);
          for (const k of unbound) {
            const i = c.params.indexOf(k);
            for (const o of live(domains[k]!)) {
              if (!kept.some((row) => row[i] === o.value)) kill(k, o.value, by);
            }
          }
          if (allBound && c.rows.length > 0 && !c.rows.some((row) => c.params.every((k, i) => b.values[k] === row[i])))
            conflicts.push({ message: by + " violated", path: `constraints[${ci}]` });
        } else if (unbound.length === 1) {
          const k = unbound[0]!;
          const i = c.params.indexOf(k);
          for (const o of live(domains[k]!)) {
            if (c.rows.some((row) => c.params.every((pk, j) => (j === i ? row[j] === o.value : b.values[pk] === row[j]))))
              kill(k, o.value, by);
          }
        } else if (allBound) {
          if (c.rows.some((row) => c.params.every((k, i) => b.values[k] === row[i])))
            conflicts.push({ message: by + " violated", path: `constraints[${ci}]` });
        }
        return;
      }

      // expr constraint
      if (c.when !== undefined) {
        try {
          if (evaluate(c.when, { vars: b.values, tables: lookups.tables }) !== true) return;
        } catch {
          return; // when not yet decidable -> inactive
        }
      }
      let refNames: string[];
      try {
        const refs: { name: string }[] = [];
        const walk = (n: import("./dsl").Ast): void => {
          if (n.t === "ident") refs.push({ name: n.name });
          else if (n.t === "un") walk(n.e);
          else if (n.t === "bin") {
            walk(n.l);
            walk(n.r);
          } else if (n.t === "tern") {
            walk(n.c);
            walk(n.a);
            walk(n.b);
          } else if (n.t === "call") n.args.forEach(walk);
        };
        walk(parse(c.assert));
        refNames = [...new Set(refs.map((r) => r.name))];
      } catch {
        return; // parse error is check.ts's job
      }
      const unbound = refNames.filter((k) => !isBound(k) && domains[k]);
      if (unbound.length === 0) {
        try {
          if (evaluate(c.assert, { vars: b.values, tables: lookups.tables }) === false)
            conflicts.push({ message: c.message, path: `constraints[${ci}]` });
        } catch {
          /* references something unbound & domainless -> not decidable */
        }
        return;
      }
      if (unbound.length === 1) {
        const k = unbound[0]!;
        for (const o of live(domains[k]!)) {
          try {
            if (evalWith(c.assert, { [k]: o.value }) === false) kill(k, o.value, c.message);
          } catch {
            // undecidable for this value (other unbound refs) -> keep it;
            // only provably inconsistent values are eliminated
          }
        }
        return;
      }
      if (unbound.length === 2) {
        const [p1, p2] = [unbound[0]!, unbound[1]!];
        const support = (a: string, av: Val, z: string) =>
          live(domains[z]!).some((o) => {
            try {
              return evalWith(c.assert, { [a]: av, [z]: o.value }) !== false;
            } catch {
              return true; // undecidable counts as support (conservative)
            }
          });
        for (const o of live(domains[p1]!)) if (!support(p1, o.value, p2)) kill(p1, o.value, c.message);
        for (const o of live(domains[p2]!)) if (!support(p2, o.value, p1)) kill(p2, o.value, c.message);
      }
      // ponytail: >2 unbound refs not propagated (validated once bound); full GAC if real models demand it
    });

    if (!changed) break;
  }

  const open = model.parameters
    .filter((p) => domains[p.key] && !(p.key in b.values) && b.visible[p.key])
    .map((p) => p.key);
  for (const k of open) {
    if (live(domains[k]!).length === 0)
      conflicts.push({ message: `no valid values remain for '${k}'`, path: `parameters.${k}` });
  }
  const candidateEstimate = open.reduce((acc, k) => acc * live(domains[k]!).length, 1);
  // Once, here, not in bindings(): evalWith reruns bindings per option. A requiredWhen that cannot
  // evaluate yet (an unbound ref) does not require anything yet — visibleWhen reads the same way.
  const required: Record<string, boolean> = {};
  for (const p of model.parameters) {
    let when = false;
    if (p.requiredWhen !== undefined)
      try {
        when = evaluate(p.requiredWhen, { vars: b.values, tables: lookups.tables }) === true;
      } catch { /* unbound: not required yet */ }
    required[p.key] = b.visible[p.key] !== false && (!!p.mandatory || when);
  }
  return { ...b, required, domains, conflicts, open, candidateEstimate };
}

const blank = (v: Val | undefined) =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);

/** What still has to be filled in before the configuration can be quoted, in form order: required
 *  parameters without a value, then the items grid — at least one row, and no blank required cell.
 *  `key` is the parameter or table key (one namespace, check.ts enforces it), so a caller can point
 *  at the field. The page hides its Create quote until this is empty; buildQuoteSeed refuses. */
export function missingInputs(
  model: ModelDef, lookups: ResolvedLookups, prop: Propagation, tableRows: TableRows,
): { key: string; message: string }[] {
  const out: { key: string; message: string }[] = [];
  for (const p of model.parameters)
    if (prop.required[p.key] && blank(prop.values[p.key])) out.push({ key: p.key, message: `${p.label || p.key} is required` });
  for (const t of model.tables ?? []) {
    const rows = tableRows[t.key] ?? [];
    const title = t.title || t.key;
    if (t.role === "items" && !rows.length) out.push({ key: t.key, message: `${title}: add at least one row` });
    // Typed cells read raw — evalTableRows zero-fills them — and computed ones evaluated, so a
    // formula that yields a value counts as an answer.
    const evald = evalTableRows(t, rows, prop.values, lookups.tables);
    for (const c of t.columns) {
      if (!requiredColumn(t, c)) continue;
      const empty = rows.flatMap((r, i) => (blank(c.cell.kind === "formula" ? evald[i]![c.key] : r[c.key]) ? [i + 1] : []));
      if (empty.length)
        out.push({ key: t.key, message: `${title}: ${c.label || c.key} is empty in row${empty.length > 1 ? "s" : ""} ${empty.join(", ")}` });
    }
  }
  return out;
}
