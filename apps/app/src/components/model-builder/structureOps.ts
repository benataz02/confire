import { isTableGroup, tokenize, type FieldGroup, type Group, type ModelDef, type Param, type TableDef } from "@confire/config-engine";

// Pure structure-tree edits for the Parameters tab. All functions return new ModelDefs.

// A table is a group, so it is addressed by position like a group is — `t:` rather than `g:` only
// so the tree can tell the two apart when drawing a row. That leaves the parameter as the tree's
// only leaf. A formula is no node of the structure (it only names the parameter it hangs under),
// but it is a row of the same table, so it is addressed here too: by its index.
export type RowRef =
  | { kind: "section"; s: number }
  | { kind: "group"; s: number; g: number }
  | { kind: "table"; s: number; g: number }
  | { kind: "param"; key: string }
  | { kind: "formula"; i: number };

export const rowKeyOf = (r: RowRef): string =>
  r.kind === "section" ? `s:${r.s}`
  : r.kind === "group" ? `g:${r.s}.${r.g}`
  : r.kind === "table" ? `t:${r.s}.${r.g}`
  : r.kind === "formula" ? `c:${r.i}`
  : `p:${r.key}`;

export function parseRowKey(k: string): RowRef {
  if (k.startsWith("s:")) return { kind: "section", s: Number(k.slice(2)) };
  if (k.startsWith("c:")) return { kind: "formula", i: Number(k.slice(2)) };
  if (k.startsWith("g:") || k.startsWith("t:")) {
    const [s, g] = k.slice(2).split(".").map(Number);
    return { kind: k[0] === "g" ? "group" : "table", s: s!, g: g! };
  }
  return { kind: "param", key: k.slice(2) };
}

export type Placement = "Before" | "After" | "On";

/** Groups and tables are the same level of the tree, so they drag by the same rules. */
const atGroupLevel = (r: RowRef) => r.kind === "group" || r.kind === "table";

export function uniqueKey(base: string, taken: string[]): string {
  let k = base, n = 2;
  while (taken.includes(k)) k = `${base}${n++}`;
  return k;
}

/** The group at a position, only if it is one a parameter can go into. */
const fieldGroupAt = (def: ModelDef, s: number, g: number): FieldGroup | undefined => {
  const grp = def.structure.sections[s]?.groups[g];
  return grp && !isTableGroup(grp) ? grp : undefined;
};

export function canDrop(def: ModelDef, srcKey: string, dstKey: string, placement: Placement): boolean {
  const src = parseRowKey(srcKey);
  const dst = parseRowKey(dstKey);
  if (srcKey === dstKey) return false;
  // A formula goes onto (or just below) the parameter it is to hang under, or beside a formula.
  if (src.kind === "formula") return (dst.kind === "param" && placement !== "Before") || (dst.kind === "formula" && placement !== "On");
  if (dst.kind === "formula") return false;
  // A parameter goes into a field group or beside another parameter. Dropping one onto a table
  // group is the one move that has to be refused here: a table group holds no parameter list, so
  // the drop would silently vanish.
  if (src.kind === "param")
    return (dst.kind === "group" && placement === "On" && !!fieldGroupAt(def, dst.s, dst.g)) || (dst.kind === "param" && placement !== "On");
  if (atGroupLevel(src)) return (dst.kind === "section" && placement === "On") || (atGroupLevel(dst) && placement !== "On");
  return dst.kind === "section" && placement !== "On";
}

/** Unplace a parameter from every group. Never deletes its definition. */
const stripParam = (def: ModelDef, key: string): ModelDef => ({
  ...def,
  structure: {
    sections: def.structure.sections.map((s) => ({
      ...s,
      groups: s.groups.map((g) => (isTableGroup(g) ? g : { ...g, params: g.params.filter((p) => p !== key) })),
    })),
  },
});

/** Drop every group that renders a table, so re-placing one can never leave a duplicate behind. */
const stripTable = (def: ModelDef, key: string): ModelDef => ({
  ...def,
  structure: {
    sections: def.structure.sections.map((s) => ({
      ...s,
      groups: s.groups.filter((g) => !(isTableGroup(g) && g.table === key)),
    })),
  },
});

/** section/group indices of the group that contains a param, or null. */
function findParam(def: ModelDef, key: string): { s: number; g: number; i: number } | null {
  for (let s = 0; s < def.structure.sections.length; s++)
    for (let g = 0; g < def.structure.sections[s]!.groups.length; g++) {
      const i = fieldGroupAt(def, s, g)?.params.indexOf(key) ?? -1;
      if (i >= 0) return { s, g, i };
    }
  return null;
}

const editGroup = (def: ModelDef, s: number, g: number, fn: (params: string[]) => string[]): ModelDef => ({
  ...def,
  structure: {
    sections: def.structure.sections.map((sec, si) =>
      si !== s ? sec : {
        ...sec,
        groups: sec.groups.map((gr, gi) => (gi !== g || isTableGroup(gr) ? gr : { ...gr, params: fn(gr.params) })),
      },
    ),
  },
});

export function applyMove(def: ModelDef, srcKey: string, dstKey: string, placement: Placement): ModelDef {
  if (!canDrop(def, srcKey, dstKey, placement)) return def;
  const src = parseRowKey(srcKey);
  const dst = parseRowKey(dstKey);

  // The array's order is the order formulas draw in under one parameter. Onto a parameter ties the
  // formula to it as its last, just below it as its first; beside a formula takes that one's tie.
  if (src.kind === "formula") {
    const c = def.computed[src.i];
    const target = dst.kind === "formula" ? def.computed[dst.i] : undefined;
    if (!c || (dst.kind === "formula" && !target)) return def;
    const rest = def.computed.filter((_, i) => i !== src.i);
    const param = dst.kind === "param" ? dst.key : target!.param;
    const first = rest.findIndex((x) => x.param === param);
    const at = dst.kind === "formula" ? rest.indexOf(target!) + (placement === "After" ? 1 : 0)
      : placement === "After" && first >= 0 ? first : rest.length;
    const { param: _, ...bare } = c;
    const moved = param === undefined ? bare : { ...bare, param };
    return { ...def, computed: [...rest.slice(0, at), moved, ...rest.slice(at)] };
  }

  if (src.kind === "param") {
    const without = stripParam(def, src.key);
    if (dst.kind === "group") return editGroup(without, dst.s, dst.g, (ps) => [...ps, src.key]);
    const dstParam = (dst as { key: string }).key;
    const at = findParam(without, dstParam);
    if (!at) return def;
    return editGroup(without, at.s, at.g, (ps) => {
      const i = ps.indexOf(dstParam) + (placement === "After" ? 1 : 0);
      return [...ps.slice(0, i), src.key, ...ps.slice(i)];
    });
  }

  if (atGroupLevel(src)) {
    const grp = def.structure.sections[src.s]!.groups[src.g]!;
    const sections = def.structure.sections.map((s, si) =>
      si === src.s ? { ...s, groups: s.groups.filter((_, gi) => gi !== src.g) } : s,
    );
    // A table group is identified by the table it names, so it is never re-keyed — uniquifying it
    // would point the group at a table that does not exist.
    const into = (si: number) => {
      if (isTableGroup(grp) || src.s === si) return grp;
      const taken = sections[si]!.groups.flatMap((g) => (isTableGroup(g) ? [] : [g.key]));
      return { ...grp, key: uniqueKey(grp.key, taken) };
    };
    if (dst.kind === "section")
      return { ...def, structure: { sections: sections.map((s, si) => (si === dst.s ? { ...s, groups: [...s.groups, into(dst.s)] } : s)) } };
    const dstGrp = dst as { s: number; g: number };
    let di = dstGrp.g;
    if (src.s === dstGrp.s && src.g < dstGrp.g) di -= 1;
    const at = di + (placement === "After" ? 1 : 0);
    const moved = into(dstGrp.s);
    return {
      ...def,
      structure: {
        sections: sections.map((s, si) =>
          si !== dstGrp.s ? s : { ...s, groups: [...s.groups.slice(0, at), moved, ...s.groups.slice(at)] },
        ),
      },
    };
  }

  if (src.kind !== "section") return def;
  const sec = def.structure.sections[src.s]!;
  const rest = def.structure.sections.filter((_, i) => i !== src.s);
  const dstSecKey = def.structure.sections[(dst as { s: number }).s]!.key;
  const at = rest.findIndex((s) => s.key === dstSecKey) + (placement === "After" ? 1 : 0);
  return { ...def, structure: { sections: [...rest.slice(0, at), sec, ...rest.slice(at)] } };
}

/** What a selection acts on: a row inside a picked section or group goes with it, so it is dropped
 *  rather than deleted or copied a second time. */
export function outermost(def: ModelDef, refs: RowRef[]): RowRef[] {
  const secs = new Set(refs.flatMap((r) => (r.kind === "section" ? [r.s] : [])));
  const grps = new Set(refs.flatMap((r) => (r.kind === "group" ? [`${r.s}.${r.g}`] : [])));
  return refs.filter((r) => {
    if (atGroupLevel(r)) return !secs.has((r as { s: number }).s);
    if (r.kind !== "param") return true;
    const at = findParam(def, r.key);
    return !at || (!secs.has(at.s) && !grps.has(`${at.s}.${at.g}`));
  });
}

/** Strip the rows and drop the parameter/table defs they held, in one pass: the refs are positions,
 *  so deleting them one after another would shift the ones still to go. */
export function deleteNodes(def: ModelDef, refs: RowRef[]): ModelDef {
  const secs = new Set(refs.flatMap((r) => (r.kind === "section" ? [r.s] : [])));
  const grps = new Set(refs.flatMap((r) => (atGroupLevel(r) ? [`${(r as { s: number }).s}.${(r as { g: number }).g}`] : [])));
  const formulas = new Set(refs.flatMap((r) => (r.kind === "formula" ? [r.i] : [])));
  const params = new Set(refs.flatMap((r) => (r.kind === "param" ? [r.key] : [])));
  const tables = new Set<string>();
  def.structure.sections.forEach((s, si) => s.groups.forEach((g, gi) => {
    if (!secs.has(si) && !grps.has(`${si}.${gi}`)) return;
    if (isTableGroup(g)) tables.add(g.table);
    else g.params.forEach((p) => params.add(p));
  }));
  return {
    ...def,
    parameters: def.parameters.filter((p) => !params.has(p.key)),
    // A formula goes with the parameter it is tied to, however that parameter went.
    computed: def.computed.filter((c, i) => !formulas.has(i) && !(c.param !== undefined && params.has(c.param))),
    tables: (def.tables ?? []).filter((t) => !tables.has(t.key)),
    structure: {
      sections: def.structure.sections.flatMap((s, si) => (secs.has(si) ? [] : [{
        ...s,
        groups: s.groups.flatMap((g, gi) => (grps.has(`${si}.${gi}`) ? []
          : [isTableGroup(g) ? g : { ...g, params: g.params.filter((p) => !params.has(p)) }])),
      }])),
    },
  };
}

/** Append a parameter to a field group, removing it from wherever it was. */
export function placeParam(def: ModelDef, key: string, s: number, g: number): ModelDef {
  return editGroup(stripParam(def, key), s, g, (ps) => [...ps, key]);
}

/** Append a table to a section as a group of its own, removing any group it already had. */
export function placeTable(def: ModelDef, key: string, s: number): ModelDef {
  const without = stripTable(def, key);
  return {
    ...without,
    structure: {
      sections: without.structure.sections.map((sec, si) =>
        si === s ? { ...sec, groups: [...sec.groups, { table: key }] } : sec,
      ),
    },
  };
}

/** The key of the table a row refers to, or undefined if the row is not a table group. */
export const tableKeyAt = (def: ModelDef, s: number, g: number): string | undefined => {
  const grp = def.structure.sections[s]?.groups[g];
  return grp && isTableGroup(grp) ? grp.table : undefined;
};

const isItemsTable = (def: ModelDef, key: string) => (def.tables ?? []).some((t) => t.key === key && t.role === "items");

/** The items grid is the one row that can be neither deleted nor copied: checkModel requires
 *  exactly one. (A section that holds it still can — its copy simply leaves the grid out.) */
export const isItemsRow = (def: ModelDef, r: RowRef) =>
  r.kind === "table" && isItemsTable(def, tableKeyAt(def, r.s, r.g) ?? "");

/** One key a duplicate creates: proposed unique, and the author's to change before it applies.
 *  `id` names the copied node; `from` is the key it copies. A copied section's groups keep their
 *  keys — group keys are unique per section, and the copy is a section of its own. */
export type CopyKey = { id: string; kind: "section" | "group" | "param" | "table" | "formula"; from: string; key: string };

/** `door` → `door2`, `door2` → `door3`: a copy of a copy counts on rather than growing `door22`. */
function nextKey(from: string, taken: string[]): string {
  const base = from.replace(/\d+$/, "") || from;
  let n = 2;
  while (taken.includes(`${base}${n}`)) n++;
  return `${base}${n}`;
}

/** Which keys a copy draws from: one pool per namespace. Parameters and formulas share one, which is
 *  the expression scope; a group's is its section's. */
const poolOf = (k: CopyKey) =>
  k.kind === "param" || k.kind === "formula" ? "ident" : k.kind === "group" ? `group:${k.id.slice(2).split(".")[0]}` : k.kind;

function takenIn(def: ModelDef, pool: string): string[] {
  if (pool === "ident") return [...def.parameters.map((p) => p.key), ...def.computed.map((c) => c.key)];
  if (pool === "section") return def.structure.sections.map((s) => s.key);
  if (pool === "table") return (def.tables ?? []).map((t) => t.key);
  const s = Number(pool.slice("group:".length));
  return def.structure.sections[s]?.groups.flatMap((g) => (isTableGroup(g) ? [] : [g.key])) ?? [];
}

/** Every key duplicating `refs` (outermost, no items row) creates, each proposed unique. */
export function copyKeys(def: ModelDef, refs: RowRef[]): CopyKey[] {
  const out: CopyKey[] = [];
  const pools = new Map<string, string[]>();
  const add = (id: string, kind: CopyKey["kind"], from: string) => {
    const k: CopyKey = { id, kind, from, key: "" };
    const pool = poolOf(k);
    const taken = pools.get(pool) ?? takenIn(def, pool);
    pools.set(pool, taken);
    k.key = nextKey(from, taken);
    taken.push(k.key);
    out.push(k);
  };
  const contents = (groups: Group[]) => groups.forEach((g) => {
    if (!isTableGroup(g)) g.params.forEach((p) => add(`p:${p}`, "param", p));
    else if (!isItemsTable(def, g.table)) add(`t:${g.table}`, "table", g.table);
  });
  for (const r of refs) {
    if (r.kind === "section") {
      const s = def.structure.sections[r.s];
      if (s) { add(`s:${r.s}`, "section", s.key); contents(s.groups); }
    } else if (r.kind === "group") {
      const g = fieldGroupAt(def, r.s, r.g);
      if (g) { add(`g:${r.s}.${r.g}`, "group", g.key); contents([g]); }
    } else if (r.kind === "table") {
      const key = tableKeyAt(def, r.s, r.g);
      if (key && !isItemsTable(def, key)) add(`t:${key}`, "table", key);
    } else if (r.kind === "param") add(`p:${r.key}`, "param", r.key);
    else {
      const c = def.computed[r.i];
      if (c) add(`c:${r.i}`, "formula", c.key);
    }
  }
  return out;
}

/** Each key's problem, by id: not an identifier, or already used in its namespace — by the model or
 *  by another copy. */
export function copyKeyIssues(def: ModelDef, keys: CopyKey[]): Record<string, "invalid" | "taken"> {
  const out: Record<string, "invalid" | "taken"> = {};
  for (const k of keys) {
    const pool = poolOf(k);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k.key)) out[k.id] = "invalid";
    else if (takenIn(def, pool).includes(k.key) || keys.some((o) => o !== k && poolOf(o) === pool && o.key === k.key))
      out[k.id] = "taken";
  }
  return out;
}

/** An expression with identifiers renamed. Token spans, not a regex: a string literal that happens
 *  to read like a key stays as it is. One that does not tokenize is left for checkModel to report.
 *  ponytail: exact identifiers only — a derived column (`door_Name`) or a table sum (`holes_count`)
 *  keeps the original's prefix; rewrite those too if copied sections start reading them. */
export function renameIdents(src: string, to: Map<string, string>): string {
  if (!to.size) return src;
  let toks: ReturnType<typeof tokenize>;
  try { toks = tokenize(src); } catch { return src; }
  let out = "", at = 0;
  for (const tk of toks) {
    const next = tk.k === "ident" ? to.get(tk.v) : undefined;
    if (next === undefined) continue;
    out += src.slice(at, tk.from) + next;
    at = tk.to;
  }
  return out + src.slice(at);
}

const PARAM_EXPRS = ["defaultExpr", "visibleWhen", "requiredWhen", "priceExpr"] as const;

/** Copy the rows under `keys` (from copyKeys), each appended at the bottom of where its source is:
 *  a section after the last section, a group or table at the end of its section, a parameter at
 *  the end of its group, a formula after the last formula. A copied group or section takes its
 *  whole content, and the copies' expressions read each other: a copied rule naming a parameter
 *  copied alongside it names the copy. */
export function duplicateNodes(def: ModelDef, refs: RowRef[], keys: CopyKey[]): ModelDef {
  const keyOf = new Map(keys.map((k) => [k.id, k.key]));
  const idents = new Map(keys.filter((k) => k.kind === "param" || k.kind === "formula").map((k) => [k.from, k.key]));
  const re = (src: string) => renameIdents(src, idents);
  const params: Param[] = [];
  const computed: ModelDef["computed"] = [];
  const tables: TableDef[] = [];

  const copyParam = (key: string): string[] => {
    const to = keyOf.get(`p:${key}`);
    const p = def.parameters.find((x) => x.key === key);
    if (!to || !p) return [];
    const copy: Param = { ...structuredClone(p), key: to };
    for (const f of PARAM_EXPRS) if (copy[f] !== undefined) copy[f] = re(copy[f]);
    params.push(copy);
    return [to];
  };
  const copyTable = (key: string): Group[] => {
    const to = keyOf.get(`t:${key}`);
    const t = (def.tables ?? []).find((x) => x.key === key);
    if (!to || !t) return [];
    tables.push({
      ...structuredClone(t), key: to,
      columns: t.columns.map((c) => (c.cell.kind === "formula" ? { ...c, cell: { ...c.cell, expr: re(c.cell.expr) } } : c)),
    });
    return [{ table: to }];
  };
  const copyGroups = (groups: Group[], key?: string): Group[] => groups.flatMap((g) => (isTableGroup(g)
    ? copyTable(g.table)
    : [{ ...g, key: key ?? g.key, params: g.params.flatMap(copyParam) }]));

  const intoSection = new Map<number, Group[]>();
  const intoGroup = new Map<string, string[]>();
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V[]) => m.set(k, [...(m.get(k) ?? []), ...v]);
  const sections: ModelDef["structure"]["sections"] = [];
  for (const r of refs) {
    if (r.kind === "section") {
      const s = def.structure.sections[r.s];
      const key = keyOf.get(`s:${r.s}`);
      if (s && key) sections.push({ ...s, key, groups: copyGroups(s.groups) });
    } else if (r.kind === "group") {
      const g = fieldGroupAt(def, r.s, r.g);
      const key = keyOf.get(`g:${r.s}.${r.g}`);
      if (g && key) push(intoSection, r.s, copyGroups([g], key));
    } else if (r.kind === "table") {
      push(intoSection, r.s, copyTable(tableKeyAt(def, r.s, r.g) ?? ""));
    } else if (r.kind === "param") {
      const at = findParam(def, r.key);
      const copied = copyParam(r.key);
      if (at) push(intoGroup, `${at.s}.${at.g}`, copied);
    } else {
      const c = def.computed[r.i];
      const key = keyOf.get(`c:${r.i}`);
      // Tied to the copy of its parameter when that is copied alongside, else to the same one.
      if (c && key) computed.push({ ...c, key, expr: re(c.expr), ...(c.param && idents.has(c.param) ? { param: idents.get(c.param) } : {}) });
    }
  }

  return {
    ...def,
    parameters: [...def.parameters, ...params],
    computed: [...def.computed, ...computed],
    tables: [...(def.tables ?? []), ...tables],
    structure: {
      sections: [
        ...def.structure.sections.map((s, si) => ({
          ...s,
          groups: [
            ...s.groups.map((g, gi) => (isTableGroup(g) ? g : { ...g, params: [...g.params, ...(intoGroup.get(`${si}.${gi}`) ?? [])] })),
            ...(intoSection.get(si) ?? []),
          ],
        })),
        ...sections,
      ],
    },
  };
}
