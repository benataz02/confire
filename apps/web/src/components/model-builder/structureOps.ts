import { placedTables, type ModelDef } from "@hera/config-engine";

// Pure structure-tree edits for the Parameters tab. All functions return new ModelDefs.

export type RowRef =
  | { kind: "section"; s: number }
  | { kind: "group"; s: number; g: number }
  | { kind: "param"; key: string }
  | { kind: "table"; key: string };

export const rowKeyOf = (r: RowRef): string =>
  r.kind === "section" ? `s:${r.s}`
  : r.kind === "group" ? `g:${r.s}.${r.g}`
  : r.kind === "table" ? `t:${r.key}`
  : `p:${r.key}`;

export function parseRowKey(k: string): RowRef {
  if (k.startsWith("s:")) return { kind: "section", s: Number(k.slice(2)) };
  if (k.startsWith("g:")) {
    const [s, g] = k.slice(2).split(".").map(Number);
    return { kind: "group", s: s!, g: g! };
  }
  if (k.startsWith("t:")) return { kind: "table", key: k.slice(2) };
  return { kind: "param", key: k.slice(2) };
}

export type Placement = "Before" | "After" | "On";

/** Parameters and tables are both leaves of a group's content list — same drag rules, same ops. */
const leaf = (r: RowRef) => r.kind === "param" || r.kind === "table";

export function uniqueKey(base: string, taken: string[]): string {
  let k = base, n = 2;
  while (taken.includes(k)) k = `${base}${n++}`;
  return k;
}

export function canDrop(_def: ModelDef, srcKey: string, dstKey: string, placement: Placement): boolean {
  const src = parseRowKey(srcKey);
  const dst = parseRowKey(dstKey);
  if (srcKey === dstKey) return false;
  // A table sits in the group's content list like a parameter does, so the two drag the same way:
  // into a group, or beside any other leaf — a table can land between two fields.
  if (leaf(src)) return (dst.kind === "group" && placement === "On") || (leaf(dst) && placement !== "On");
  if (src.kind === "group") return (dst.kind === "section" && placement === "On") || (dst.kind === "group" && placement !== "On");
  return dst.kind === "section" && placement !== "On";
}

/** Unplace a parameter or table from every group. Never deletes its definition. */
const stripParam = (def: ModelDef, key: string): ModelDef => ({
  ...def,
  structure: {
    sections: def.structure.sections.map((s) => ({
      ...s,
      groups: s.groups.map((g) => ({ ...g, params: g.params.filter((p) => p !== key) })),
    })),
  },
});

/** section/group indices of the group that contains a param, or null. */
function findParam(def: ModelDef, key: string): { s: number; g: number; i: number } | null {
  for (let s = 0; s < def.structure.sections.length; s++)
    for (let g = 0; g < def.structure.sections[s]!.groups.length; g++) {
      const i = def.structure.sections[s]!.groups[g]!.params.indexOf(key);
      if (i >= 0) return { s, g, i };
    }
  return null;
}

const editGroup = (def: ModelDef, s: number, g: number, fn: (params: string[]) => string[]): ModelDef => ({
  ...def,
  structure: {
    sections: def.structure.sections.map((sec, si) =>
      si !== s ? sec : { ...sec, groups: sec.groups.map((gr, gi) => (gi !== g ? gr : { ...gr, params: fn(gr.params) })) },
    ),
  },
});

export function applyMove(def: ModelDef, srcKey: string, dstKey: string, placement: Placement): ModelDef {
  if (!canDrop(def, srcKey, dstKey, placement)) return def;
  const src = parseRowKey(srcKey);
  const dst = parseRowKey(dstKey);

  if (leaf(src)) {
    const key = (src as { key: string }).key;
    const without = stripParam(def, key);
    if (dst.kind === "group") return editGroup(without, dst.s, dst.g, (ps) => [...ps, key]);
    const at = findParam(without, (dst as { key: string }).key);
    if (!at) return def;
    return editGroup(without, at.s, at.g, (ps) => {
      const i = ps.indexOf((dst as { key: string }).key) + (placement === "After" ? 1 : 0);
      return [...ps.slice(0, i), key, ...ps.slice(i)];
    });
  }

  if (src.kind === "group") {
    const grp = def.structure.sections[src.s]!.groups[src.g]!;
    const sections = def.structure.sections.map((s, si) =>
      si === src.s ? { ...s, groups: s.groups.filter((_, gi) => gi !== src.g) } : s,
    );
    const into = (si: number) => {
      const taken = sections[si]!.groups.map((g) => g.key);
      return src.s === si ? grp : { ...grp, key: uniqueKey(grp.key, taken) };
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
  if (leaf(ref)) return stripParam(def, (ref as { key: string }).key);
  if (ref.kind === "group")
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

/** Append a parameter or table to a group, removing it from wherever it was. */
export function placeParam(def: ModelDef, key: string, s: number, g: number): ModelDef {
  return editGroup(stripParam(def, key), s, g, (ps) => [...ps, key]);
}

/** Table keys the form would push into its trailing catch-all section. */
export function unplacedTables(def: ModelDef): string[] {
  const placed = new Set(placedTables(def));
  return (def.tables ?? []).map((t) => t.key).filter((k) => !placed.has(k));
}

export function unplacedParams(def: ModelDef): string[] {
  const placed = new Set(def.structure.sections.flatMap((s) => s.groups.flatMap((g) => g.params)));
  return def.parameters.map((p) => p.key).filter((k) => !placed.has(k));
}

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
          const i = g.params.indexOf(key);
          if (i < 0) return g;
          return { ...g, params: [...g.params.slice(0, i + 1), copyKey, ...g.params.slice(i + 1)] };
        }),
      })),
    },
  };
}
