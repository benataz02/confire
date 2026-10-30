import { sectionFields } from "../metadata.ts";
import type { FormField, ListColumn, ObjectViewState, Section } from "../types.ts";

// Object views: personalization over the DECLARED sections and fields — which show, and in what
// order. A view can only narrow and reorder what the feature declares; it never adds.

/** What a section's layout lists: its form fields, or its table's columns — a declared `hidden`
 *  column being one Standard leaves out. */
const entriesOf = (s: Section): ObjectViewState["sections"][number]["fields"] =>
  s.table ? s.table.columns.map((c) => ({ key: c.key, visible: !c.hidden })) : sectionFields(s).map((f) => ({ key: f.key, visible: true }));

/** Everything declared, in declared order — what Standard is. */
export function defaultObjectState(sections: Section[]): ObjectViewState {
  return { sections: sections.map((s) => ({ id: s.id, visible: true, fields: entriesOf(s) })) };
}

/** A table section's grid settings (its gear) as the layout: `keys` shown in that order, every
 *  other column hidden after them. Keys the section does not list are dropped. */
export function withTableColumns(state: ObjectViewState, id: string, keys: string[]): ObjectViewState {
  return {
    sections: state.sections.map((s) => {
      if (s.id !== id) return s;
      const shown = keys.filter((k) => s.fields.some((f) => f.key === k));
      return {
        ...s,
        fields: [
          ...shown.map((key) => ({ key, visible: true })),
          ...s.fields.filter((f) => !shown.includes(f.key)).map((f) => ({ key: f.key, visible: false })),
        ],
      };
    }),
  };
}

/** A saved layout against today's sections: its own order first, then whatever the feature gained
 *  since (shown); what the feature dropped is dropped. */
export function resolveObjectState(saved: Partial<ObjectViewState> | null, sections: Section[]): ObjectViewState {
  const d = defaultObjectState(sections);
  if (!saved?.sections?.length) return d;
  const known = new Map(saved.sections.map((s) => [s.id, s]));
  const merge = (def: ObjectViewState["sections"][number]) => {
    const s = known.get(def.id);
    if (!s) return def;
    const keys = new Set(def.fields.map((f) => f.key));
    const kept = s.fields.filter((f) => keys.has(f.key));
    return { ...def, visible: s.visible, fields: [...kept, ...def.fields.filter((f) => !kept.some((k) => k.key === f.key))] };
  };
  const ordered = saved.sections.flatMap((s) => {
    const def = d.sections.find((x) => x.id === s.id);
    return def ? [merge(def)] : [];
  });
  return { sections: [...ordered, ...d.sections.filter((x) => !known.has(x.id))] };
}

/**
 * The sections the page draws under a layout. `mustShow` keeps a field visible whatever the view
 * says — in edit mode, every editable or required field (a create page must be able to send what
 * the server requires).
 */
export function applyObjectView(sections: Section[], state: ObjectViewState, mustShow: (f: FormField) => boolean): Section[] {
  const byId = new Map(sections.map((s) => [s.id, s]));
  return state.sections.flatMap((v) => {
    const s = byId.get(v.id);
    if (!s) return [];
    if (!v.visible && !sectionFields(s).some(mustShow)) return [];
    const at = new Map(v.fields.map((f, i) => [f.key, { ...f, i }]));
    const rank = (k: string) => at.get(k)?.i ?? Number.MAX_SAFE_INTEGER;
    const fields = (fs: FormField[] | undefined) =>
      fs
        ?.filter((f) => f.controlType === "fieldGroup" || at.get(f.key)?.visible !== false || mustShow(f))
        .sort((a, b) => rank(a.key) - rank(b.key));
    // The view decides, the declared `hidden` being only Standard's. Unchanged columns stay the same
    // objects: EditGrid keeps its cells mounted while they are.
    const columns = (cs: ListColumn[]) =>
      cs.map((c) => {
        const shown = at.get(c.key)?.visible ?? !c.hidden;
        return shown === !c.hidden ? c : { ...c, hidden: !shown };
      }).sort((a, b) => rank(a.key) - rank(b.key));
    return [{
      ...s,
      ...(s.fields ? { fields: fields(s.fields) } : {}),
      ...(s.groups ? { groups: s.groups.map((g) => ({ ...g, fields: fields(g.fields)! })) } : {}),
      ...(s.subsections ? {
        subsections: s.subsections.map((sub) => ({
          ...sub,
          ...(sub.fields ? { fields: fields(sub.fields) } : {}),
          ...(sub.groups ? { groups: sub.groups.map((g) => ({ ...g, fields: fields(g.fields)! })) } : {}),
        })),
      } : {}),
      ...(s.table ? { table: { ...s.table, columns: columns(s.table.columns) } } : {}),
    }];
  });
}
