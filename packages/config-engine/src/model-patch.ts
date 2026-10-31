import { z } from "zod";
import { isTableGroup, ModelDefZ, ParamZ, TableDefZ, type ModelDef } from "./model";

// A model is saved as what changed since the last save, not as the whole document: the builder
// diffs its draft against the definition it loaded (`diffModel`) and the server lays that over the
// stored one (`applyModelPatch`). Lists whose items carry a key go per item, so two admins editing
// different parameters both keep their edit; the same item edited by both is the later save's.
// The keyless parts go whole, and only when they changed.

const KEYED = ["parameters", "computed", "tables"] as const;
const WHOLE = ["name", "description", "structure", "constraints", "bom", "routing", "history", "pricing", "batchDefaults"] as const;
// A ModelDef key in neither list would silently stop being saved.
const _covered: Exclude<keyof ModelDef, (typeof KEYED)[number] | (typeof WHOLE)[number]> extends never ? true : never = true;
void _covered;

/** `order` is only sent when the keys' sequence changed beyond what upsert (appends) and remove do. */
const keyed = <T extends z.ZodType>(item: T) => z.object({
  upsert: z.array(item).optional(),
  remove: z.array(z.string()).optional(),
  order: z.array(z.string()).optional(),
}).optional();

const S = ModelDefZ.shape;
/** Each part is validated on its own here; the merged model is checkModel's on the server. */
export const ModelPatchZ = z.object({
  name: S.name.optional(),
  // null removes an optional part: JSON has no way to send `undefined`.
  description: z.string().nullable().optional(),
  parameters: keyed(ParamZ),
  computed: keyed(S.computed.element),
  tables: keyed(TableDefZ),
  structure: S.structure.optional(),
  constraints: S.constraints.optional(),
  bom: S.bom.optional(),
  routing: S.routing.optional(),
  history: S.history.unwrap().nullable().optional(),
  pricing: S.pricing.optional(),
  batchDefaults: S.batchDefaults.optional(),
});
export type ModelPatch = z.infer<typeof ModelPatchZ>;
type Keyed = { key: string };
type KeyedPatch<T> = { upsert?: T[]; remove?: string[]; order?: string[] };

/** JSON with object keys sorted and `undefined` dropped. Postgres reorders jsonb keys and a spread
 *  reorders them too, so plain JSON.stringify would call an untouched item changed. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

function applyKeyed<T extends Keyed>(list: T[], p: KeyedPatch<T>): T[] {
  const gone = new Set(p.remove);
  const up = new Map((p.upsert ?? []).map((x) => [x.key, x]));
  const out = list.filter((x) => !gone.has(x.key)).map((x) => up.get(x.key) ?? x);
  const have = new Set(out.map((x) => x.key));
  for (const x of p.upsert ?? []) if (!have.has(x.key)) { out.push(x); have.add(x.key); }
  const order = p.order;
  if (!order) return out;
  // A key the order does not name — another admin's addition since this draft loaded — keeps its
  // place relative to the others, after every key that is named.
  const rank = new Map(order.map((k, i) => [k, i]));
  return out
    .map((x, i) => ({ x, r: rank.get(x.key) ?? order.length + i }))
    .sort((a, b) => a.r - b.r)
    .map(({ x }) => x);
}

function diffKeyed<T extends Keyed>(a: T[], b: T[]): KeyedPatch<T> | undefined {
  const before = new Map(a.map((x) => [x.key, x]));
  const kept = new Set(b.map((x) => x.key));
  const p: KeyedPatch<T> = {};
  const upsert = b.filter((x) => !before.has(x.key) || !sameJson(before.get(x.key), x));
  const remove = a.filter((x) => !kept.has(x.key)).map((x) => x.key);
  if (upsert.length) p.upsert = upsert;
  if (remove.length) p.remove = remove;
  const order = b.map((x) => x.key);
  if (!sameJson(applyKeyed(a, p).map((x) => x.key), order)) p.order = order;
  return Object.keys(p).length ? p : undefined;
}

/** What turns `base` into `next`. Empty when they are the same model, key order aside. */
export function diffModel(base: ModelDef, next: ModelDef): ModelPatch {
  const out: Record<string, unknown> = {};
  for (const k of WHOLE) if (!sameJson(base[k], next[k])) out[k] = next[k] ?? null;
  for (const k of KEYED) {
    const p = diffKeyed<Keyed>(base[k] ?? [], next[k] ?? []);
    if (p) out[k] = p;
  }
  return out as ModelPatch;
}

export const isEmptyPatch = (p: ModelPatch): boolean => Object.keys(p).length === 0;

/** `patch` laid over `def`, which may have moved on since the patch was diffed. */
export function applyModelPatch(def: ModelDef, patch: ModelPatch): ModelDef {
  const out: Record<string, unknown> = { ...def };
  for (const k of WHOLE) {
    const v = patch[k];
    if (v === null) delete out[k];
    else if (v !== undefined) out[k] = v;
  }
  for (const k of KEYED) {
    const p = patch[k] as KeyedPatch<Keyed> | undefined;
    if (p) out[k] = applyKeyed<Keyed>(def[k] ?? [], p);
  }
  return keepPlaced(def, out as ModelDef);
}

/** `section/group` of every field group, and of the group placing each parameter. */
function placements(d: ModelDef): { groups: Set<string>; of: Map<string, string> } {
  const groups = new Set<string>();
  const of = new Map<string, string>();
  for (const s of d.structure.sections)
    for (const g of s.groups) {
      if (isTableGroup(g)) continue;
      groups.add(`${s.key}/${g.key}`);
      for (const p of g.params) of.set(p, `${s.key}/${g.key}`);
    }
  return { groups, of };
}

/** A parameter exists only while a group places it — the builder deletes a group's parameters with
 *  it. A patch is diffed against what that builder loaded, so its whole structure never names a
 *  parameter another save added since: that one goes back into the group it was stored in, or, the
 *  patch having deleted that group, goes with it, as do the formulas tied to it. A parameter that
 *  was already stored in no group goes too. */
function keepPlaced(before: ModelDef, after: ModelDef): ModelDef {
  const now = placements(after);
  const was = placements(before).of;
  const back = new Map<string, string[]>();
  const gone = new Set<string>();
  for (const p of after.parameters) {
    if (now.of.has(p.key)) continue;
    const g = was.get(p.key);
    if (g && now.groups.has(g)) back.set(g, [...(back.get(g) ?? []), p.key]);
    else gone.add(p.key);
  }
  if (!back.size && !gone.size) return after;
  return {
    ...after,
    parameters: after.parameters.filter((p) => !gone.has(p.key)),
    computed: after.computed.filter((c) => c.param === undefined || !gone.has(c.param)),
    structure: {
      sections: after.structure.sections.map((s) => ({
        ...s,
        groups: s.groups.map((g) => (isTableGroup(g) ? g : { ...g, params: [...g.params, ...(back.get(`${s.key}/${g.key}`) ?? [])] })),
      })),
    },
  };
}
