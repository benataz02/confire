import { tokenize, type Group, type ModelDef, type Param, type TableDef } from "@confire/config-engine";

// Pure structure-tree edits for the Parameters tab. All functions return new ModelDefs.

// Parameters, tables and tenant visuals are the tree's leaves: a group lists them all, by key (one
// namespace), so all are addressed by key — `t:`/`v:` rather than `p:` only so the tree can tell
// them apart when drawing a row. A formula is no node of the structure (it only names the parameter it hangs under), but it
// is a row of the same table, so it is addressed here too: by its index.
export type RowRef =
  | { kind: "section"; s: number }
  | { kind: "group"; s: number; g: number }
  | { kind: "table"; key: string }
  | { kind: "visual"; key: string }
  | { kind: "param"; key: string }
  | { kind: "formula"; i: number };

export const rowKeyOf = (r: RowRef): string =>
  r.kind === "section" ? `s:${r.s}`
  : r.kind === "group" ? `g:${r.s}.${r.g}`
  : r.kind === "table" ? `t:${r.key}`
  : r.kind === "visual" ? `v:${r.key}`
  : r.kind === "formula" ? `c:${r.i}`
  : `p:${r.key}`;

export function parseRowKey(k: string): RowRef {
  if (k.startsWith("s:")) return { kind: "section", s: Number(k.slice(2)) };
  if (k.startsWith("c:")) return { kind: "formula", i: Number(k.slice(2)) };
  if (k.startsWith("g:")) {
    const [s, g] = k.slice(2).split(".").map(Number);
    return { kind: "group", s: s!, g: g! };
  }
  return { kind: k[0] === "t" ? "table" : k[0] === "v" ? "visual" : "param", key: k.slice(2) };
}

export type Placement = "Before" | "After" | "On";

/** A parameter, a table or a visual: what a group lists. They drag and delete by the same rules
 *  (a copy leaves a visual out — see copyKeys). */
const isLeaf = (r: RowRef): r is { kind: "param" | "table" | "visual"; key: string } =>
  r.kind === "param" || r.kind === "table" || r.kind === "visual";

export function uniqueKey(base: string, taken: string[]): string {
  let k = base, n = 2;
  while (taken.includes(k)) k = `${base}${n++}`;
  return k;
}

/** What TitleDialog edits on a section or a field group. */
export type Heading = { title: string; visibleWhen?: string };

const withHeading = <T extends { title: string; visibleWhen?: string }>({ visibleWhen: _v, ...node }: T, h: Heading): T =>
  ({ ...node, title: h.title, ...(h.visibleWhen === undefined ? {} : { visibleWhen: h.visibleWhen }) }) as T;

/** Set the heading of the section at `s`, or of its group `g`. */
export function setHeading(def: ModelDef, at: { s: number; g?: number }, h: Heading): ModelDef {
  return {
    ...def,
    structure: {
      sections: def.structure.sections.map((s, si) => si !== at.s ? s
        : at.g === undefined ? withHeading(s, h)
        : { ...s, groups: s.groups.map((g, gi) => (gi === at.g ? withHeading(g, h) : g)) }),
    },
  };
}

const groupAt = (def: ModelDef, s: number, g: number): Group | undefined => def.structure.sections[s]?.groups[g];

export function canDrop(def: ModelDef, srcKey: string, dstKey: string, placement: Placement): boolean {
  const src = parseRowKey(srcKey);
  const dst = parseRowKey(dstKey);
  if (srcKey === dstKey) return false;
  // A formula goes onto (or just below) the parameter it is to hang under, or beside a formula.
  if (src.kind === "formula") return (dst.kind === "param" && placement !== "Before") || (dst.kind === "formula" && placement !== "On");
  if (dst.kind === "formula") return false;
  // A parameter or table goes into a group or beside another one.
  if (isLeaf(src)) return (dst.kind === "group" && placement === "On" && !!groupAt(def, dst.s, dst.g)) || (isLeaf(dst) && placement !== "On");
  if (src.kind === "group") return (dst.kind === "section" && placement === "On") || (dst.kind === "group" && placement !== "On");
  return dst.kind === "section" && placement !== "On";
}

/** Unplace a parameter or table from every group. Never deletes its definition. */
const strip = (def: ModelDef, key: string): ModelDef => ({
  ...def,
  structure: {
    sections: def.structure.sections.map((s) => ({
      ...s,
      groups: s.groups.map((g) => ({ ...g, params: g.params.filter((p) => p !== key) })),
    })),
  },
});

/** section/group indices of the group that places a parameter or table, or null. */
export function findPlaced(def: ModelDef, key: string): { s: number; g: number; i: number } | null {
  for (let s = 0; s < def.structure.sections.length; s++)
    for (let g = 0; g < def.structure.sections[s]!.groups.length; g++) {
      const i = groupAt(def, s, g)?.params.indexOf(key) ?? -1;
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
        groups: sec.groups.map((gr, gi) => (gi !== g ? gr : { ...gr, params: fn(gr.params) })),
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

  if (isLeaf(src)) {
    const without = strip(def, src.key);
    if (dst.kind === "group") return editGroup(without, dst.s, dst.g, (ps) => [...ps, src.key]);
    const dstKey = (dst as { key: string }).key;
    const at = findPlaced(without, dstKey);
    if (!at) return def;
    return editGroup(without, at.s, at.g, (ps) => {
      const i = ps.indexOf(dstKey) + (placement === "After" ? 1 : 0);
      return [...ps.slice(0, i), src.key, ...ps.slice(i)];
    });
  }

  if (src.kind === "group") {
    const grp = def.structure.sections[src.s]!.groups[src.g]!;
    const sections = def.structure.sections.map((s, si) =>
      si === src.s ? { ...s, groups: s.groups.filter((_, gi) => gi !== src.g) } : s,
    );
    const into = (si: number) => (src.s === si ? grp : { ...grp, key: uniqueKey(grp.key, sections[si]!.groups.map((g) => g.key)) });
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
    if (r.kind === "group") return !secs.has(r.s);
    if (!isLeaf(r)) return true;
    const at = findPlaced(def, r.key);
    return !at || (!secs.has(at.s) && !grps.has(`${at.s}.${at.g}`));
  });
}

/** Strip the rows and drop the parameter/table defs they held, in one pass: the refs are positions,
 *  so deleting them one after another would shift the ones still to go. */
export function deleteNodes(def: ModelDef, refs: RowRef[]): ModelDef {
  const secs = new Set(refs.flatMap((r) => (r.kind === "section" ? [r.s] : [])));
  const grps = new Set(refs.flatMap((r) => (r.kind === "group" ? [`${r.s}.${r.g}`] : [])));
  const formulas = new Set(refs.flatMap((r) => (r.kind === "formula" ? [r.i] : [])));
  // Parameter and table keys share one namespace, so one set covers both.
  const keys = new Set(refs.flatMap((r) => (isLeaf(r) ? [r.key] : [])));
  def.structure.sections.forEach((s, si) => s.groups.forEach((g, gi) => {
    if (secs.has(si) || grps.has(`${si}.${gi}`)) g.params.forEach((p) => keys.add(p));
  }));
  return {
    ...def,
    parameters: def.parameters.filter((p) => !keys.has(p.key)),
    // A formula goes with the parameter it is tied to, however that parameter went.
    computed: def.computed.filter((c, i) => !formulas.has(i) && !(c.param !== undefined && keys.has(c.param))),
    tables: (def.tables ?? []).filter((t) => !keys.has(t.key)),
    ...(def.visuals ? { visuals: def.visuals.filter((v) => !keys.has(v.key)) } : {}),
    structure: {
      sections: def.structure.sections.flatMap((s, si) => (secs.has(si) ? [] : [{
        ...s,
        groups: s.groups.flatMap((g, gi) => (grps.has(`${si}.${gi}`) ? [] : [{ ...g, params: g.params.filter((p) => !keys.has(p)) }])),
      }])),
    },
  };
}

/** Append a parameter or table to a group, removing it from wherever it was. */
export function placeParam(def: ModelDef, key: string, s: number, g: number): ModelDef {
  return editGroup(strip(def, key), s, g, (ps) => [...ps, key]);
}

const isItemsTable = (def: ModelDef, key: string) => (def.tables ?? []).some((t) => t.key === key && t.role === "items");

/** The items grid is the one row that can be neither deleted nor copied: checkModel requires
 *  exactly one. (A section that holds it still can — its copy simply leaves the grid out.) */
export const isItemsRow = (def: ModelDef, r: RowRef) => r.kind === "table" && isItemsTable(def, r.key);

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

/** Which keys a copy draws from: one pool per namespace. Parameters, formulas and tables share one,
 *  which is the expression scope; a group's is its section's. */
const poolOf = (k: CopyKey) =>
  k.kind === "group" ? `group:${k.id.slice(2).split(".")[0]}` : k.kind === "section" ? "section" : "ident";

function takenIn(def: ModelDef, pool: string): string[] {
  if (pool === "ident") return [
    ...def.parameters.map((p) => p.key), ...def.computed.map((c) => c.key), ...(def.tables ?? []).map((t) => t.key),
    ...(def.visuals ?? []).map((v) => v.key),
  ];
  if (pool === "section") return def.structure.sections.map((s) => s.key);
  const s = Number(pool.slice("group:".length));
  return def.structure.sections[s]?.groups.map((g) => g.key) ?? [];
}

const isTable = (def: ModelDef, key: string) => (def.tables ?? []).some((t) => t.key === key);

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
  // A copy leaves a visual out, as it leaves the items grid out: one per group, and tenant code.
  const isVisual = (k: string) => (def.visuals ?? []).some((v) => v.key === k);
  const leaf = (k: string) => {
    if (isVisual(k)) return;
    if (!isTable(def, k)) add(`p:${k}`, "param", k);
    else if (!isItemsTable(def, k)) add(`t:${k}`, "table", k);
  };
  const contents = (groups: Group[]) => groups.forEach((g) => g.params.forEach(leaf));
  for (const r of refs) {
    if (r.kind === "section") {
      const s = def.structure.sections[r.s];
      if (s) { add(`s:${r.s}`, "section", s.key); contents(s.groups); }
    } else if (r.kind === "group") {
      const g = groupAt(def, r.s, r.g);
      if (g) { add(`g:${r.s}.${r.g}`, "group", g.key); contents([g]); }
    } else if (isLeaf(r)) leaf(r.key);
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
 *  a section after the last section, a group at the end of its section, a parameter or table at
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
  const copyTable = (key: string): string[] => {
    const to = keyOf.get(`t:${key}`);
    const t = (def.tables ?? []).find((x) => x.key === key);
    if (!to || !t) return [];
    tables.push({
      ...structuredClone(t), key: to,
      columns: t.columns.map((c) => (c.cell.kind === "formula" ? { ...c, cell: { ...c.cell, expr: re(c.cell.expr) } } : c)),
    });
    return [to];
  };
  const copyLeaf = (key: string) => (isTable(def, key) ? copyTable(key) : copyParam(key));
  const copyGroups = (groups: Group[], key?: string): Group[] => groups.map((g) =>
    ({ ...g, key: key ?? g.key, params: g.params.flatMap(copyLeaf), ...(g.visibleWhen === undefined ? {} : { visibleWhen: re(g.visibleWhen) }) }));

  const intoSection = new Map<number, Group[]>();
  const intoGroup = new Map<string, string[]>();
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V[]) => m.set(k, [...(m.get(k) ?? []), ...v]);
  const sections: ModelDef["structure"]["sections"] = [];
  for (const r of refs) {
    if (r.kind === "section") {
      const s = def.structure.sections[r.s];
      const key = keyOf.get(`s:${r.s}`);
      if (s && key) sections.push({ ...s, key, groups: copyGroups(s.groups), ...(s.visibleWhen === undefined ? {} : { visibleWhen: re(s.visibleWhen) }) });
    } else if (r.kind === "group") {
      const g = groupAt(def, r.s, r.g);
      const key = keyOf.get(`g:${r.s}.${r.g}`);
      if (g && key) push(intoSection, r.s, copyGroups([g], key));
    } else if (isLeaf(r)) {
      const at = findPlaced(def, r.key);
      const copied = copyLeaf(r.key);
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
            ...s.groups.map((g, gi) => ({ ...g, params: [...g.params, ...(intoGroup.get(`${si}.${gi}`) ?? [])] })),
            ...(intoSection.get(si) ?? []),
          ],
        })),
        ...sections,
      ],
    },
  };
}
