/** Path of the model a URL belongs to: `/<slug>/models/<id>`, and `/models/new` is an id.
 *  The id is one segment, so `/models/new` and `/models/newish` are different models. */
export function modelPathRoot(pathname: string): string | null {
  return pathname.match(/^(\/[^/]+\/models\/[^/]+)/)?.[1] ?? null;
}

/** Navigation that stays on this model — the builder and its parameter page share one draft. */
export function sameModelPath(current: string, next: string): boolean {
  const root = modelPathRoot(current);
  return root !== null && root === modelPathRoot(next);
}

/** Search of `/$slug/models/$id/parameter`. A key in the path would steal a parameter named `new`. */
export type ParamSearch = { key?: string; s?: number; g?: number };

const placement = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
};

export function paramSearch(s: Record<string, unknown>): ParamSearch {
  const out: ParamSearch = {};
  if (typeof s.key === "string" && s.key !== "") out.key = s.key;
  const sIndex = placement(s.s);
  const gIndex = placement(s.g);
  if (sIndex !== undefined) out.s = sIndex;
  if (gIndex !== undefined) out.g = gIndex;
  return out;
}

/** Search of `/$slug/models/$id/table`: the key of a table that exists — tables are added in the tree. */
export type TableSearch = { key: string };

export const tableSearch = (s: Record<string, unknown>): TableSearch => ({ key: typeof s.key === "string" ? s.key : "" });

// Spread reorders keys, and a cleared field is `undefined`. Both have to compare equal to the
// value the page opened on, or the unsaved mark sticks after an edit is typed back.
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

export const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
