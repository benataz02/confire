import { isTableGroup, type FieldGroup, type ModelDef } from "@confire/config-engine";

// Pure structure-tree edits for the Parameters tab. All functions return new ModelDefs.

// A table is a group, so it is addressed by position like a group is — `t:` rather than `g:` only
// so the tree can tell the two apart when drawing a row and picking its actions. That leaves the
// parameter as the tree's only leaf.
export type RowRef =
  | { kind: "section"; s: number }
  | { kind: "group"; s: number; g: number }
  | { kind: "table"; s: number; g: number }
  | { kind: "param"; key: string };

export const rowKeyOf = (r: RowRef): string =>
  r.kind === "section" ? `s:${r.s}`
  : r.kind === "group" ? `g:${r.s}.${r.g}`
  : r.kind === "table" ? `t:${r.s}.${r.g}`
  : `p:${r.key}`;

export function parseRowKey(k: string): RowRef {
  if (k.startsWith("s:")) return { kind: "section", s: Number(k.slice(2)) };
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

  // section reorder
  const sec = def.structure.sections[src.s]!;
  const rest = def.structure.sections.filter((_, i) => i !== src.s);
  const dstSecKey = def.structure.sections[(dst as { s: number }).s]!.key;
  const at = rest.findIndex((s) => s.key === dstSecKey) + (placement === "After" ? 1 : 0);
  return { ...def, structure: { sections: [...rest.slice(0, at), sec, ...rest.slice(at)] } };
}

export function removeFromStructure(def: ModelDef, ref: RowRef): ModelDef {
  if (ref.kind === "param") return stripParam(def, ref.key);
  if (atGroupLevel(ref))
    return {
      ...def,
      structure: {
        sections: def.structure.sections.map((s, si) =>
          si === ref.s ? { ...s, groups: s.groups.filter((_, gi) => gi !== ref.g) } : s,
        ),
      },
    };
  return { ...def, structure: { sections: def.structure.sections.filter((_, si) => si !== ref.s) } };
}

/** Strip a node and drop the parameter/table defs it held. Unplaced leftovers have no repair UI. */
export function deleteNode(def: ModelDef, ref: RowRef): ModelDef {
  const groups = ref.kind === "section" ? (def.structure.sections[ref.s]?.groups ?? [])
    : ref.kind === "group" || ref.kind === "table" ? [def.structure.sections[ref.s]?.groups[ref.g]]
    : [];
  const paramKeys = new Set(ref.kind === "param" ? [ref.key]
    : groups.flatMap((g) => (g && !isTableGroup(g) ? g.params : [])));
  const tableKeys = new Set(groups.flatMap((g) => (g && isTableGroup(g) ? [g.table] : [])));
  const out = removeFromStructure(def, ref);
  return {
    ...out,
    parameters: out.parameters.filter((p) => !paramKeys.has(p.key)),
    tables: (out.tables ?? []).filter((t) => !tableKeys.has(t.key)),
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

/** Clone a param, uniquify its key, and insert it after the source (same group if placed). */
export function duplicateParam(def: ModelDef, key: string): ModelDef {
  const src = def.parameters.find((p) => p.key === key);
  if (!src) return def;
  const taken = [...def.parameters.map((p) => p.key), ...def.computed.map((c) => c.key)];
  let copyKey = key, n = 2;
  while (taken.includes(copyKey)) copyKey = `${key}${n++}`;
  const copy = { ...structuredClone(src), key: copyKey };
  const at = def.parameters.findIndex((p) => p.key === key);
  return {
    ...def,
    parameters: [...def.parameters.slice(0, at + 1), copy, ...def.parameters.slice(at + 1)],
    structure: {
      sections: def.structure.sections.map((s) => ({
        ...s,
        groups: s.groups.map((g) => {
          if (isTableGroup(g)) return g;
          const i = g.params.indexOf(key);
          if (i < 0) return g;
          return { ...g, params: [...g.params.slice(0, i + 1), copyKey, ...g.params.slice(i + 1)] };
        }),
      })),
    },
  };
}
