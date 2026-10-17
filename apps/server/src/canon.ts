/** JSON with object keys sorted. Plain JSON.stringify will not do: Postgres reorders jsonb object
 *  keys, so a value read back from a jsonb column would compare (and hash) differently from the
 *  one written. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
