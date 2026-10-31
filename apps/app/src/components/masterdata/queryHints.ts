// The masterdata query's suggestions, off the source's metadata: each box completes the token at
// its end. A hint's `text` is the whole completed value, never the token alone — Input puts the
// picked item's text in the box (and previews it there while arrowing), which would wipe the rest.

export type Target = "b1" | "beas";
export type FieldInfo = { name: string; kind: string; label?: string; values?: string[] };
export type Hint = { text: string; info?: string };
/** `anywhere`: a name, matched inside too (`Code` finds ItemsGroupCode); a keyword by its start only. */
type Word = { word: string; info?: string; anywhere?: boolean };

const CMP = ["eq", "ne", "gt", "ge", "lt", "le"];
// Beas refuses every function ("A logic command is always [item] [logical comand] [value]") and `in`,
// and has infix like/startwith/endwith instead; B1 is OData v4's functions (hera, 2026-10-30).
const OPS: Record<Target, string[]> = { b1: CMP, beas: [...CMP, "like", "startwith", "endwith"] };
const FUNCS: Record<Target, string[]> = { b1: ["contains(", "startswith("], beas: [] };
// ponytail: a flat cap; past it the user types a letter more, as in any value help's type-ahead.
const CAP = 50;

const word = (w: string): Word => ({ word: w });
const fieldWords = (fields: FieldInfo[]): Word[] =>
  fields.map((f) => ({ word: f.name, info: [f.label, f.kind].filter(Boolean).join(" · "), anywhere: true }));

/** The token being typed (`frag`), what precedes it, and the token before that (`prev`). */
function split(text: string, token: RegExp) {
  const frag = token.exec(text)?.[0] ?? "";
  const head = text.slice(0, text.length - frag.length);
  const before = head.trimEnd();
  const prev = /(?:'(?:[^']|'')*'|"[^"]*"|[\w.-]+|[(),])$/.exec(before)?.[0] ?? "";
  return { frag, head, before, prev };
}

/** Words starting with the fragment, then names containing it; the fragment itself is no hint. */
function complete(head: string, frag: string, pool: Word[]): Hint[] {
  const f = frag.toLowerCase();
  return pool
    .flatMap((w) => {
      const at = w.word.toLowerCase().indexOf(f);
      return at < 0 || (at > 0 && !w.anywhere) || w.word === frag ? [] : [{ w, rank: at === 0 ? 0 : 1 }];
    })
    .sort((a, b) => a.rank - b.rank)
    .slice(0, CAP)
    .map(({ w }) => ({ text: head + w.word, info: w.info }));
}

/** Select: the fields not listed yet. */
export function selectHints(text: string, fields: FieldInfo[]): Hint[] {
  const { frag, head } = split(text, /\w*$/);
  const taken = new Set(head.split(/[,\s]+/));
  return complete(head, frag, fieldWords(fields.filter((f) => !taken.has(f.name))));
}

/** Sort: a field, then its direction. */
export function sortHints(text: string, fields: FieldInfo[]): Hint[] {
  const { frag, head, prev } = split(text, /\w*$/);
  const pool = !prev || prev === "," ? fieldWords(fields)
    : fields.some((f) => f.name === prev) ? ["asc", "desc"].map(word) : [];
  return complete(head, frag, pool);
}

/** Filter: a field (or, on B1, a function), its operator, its values when the metadata knows them,
 *  then and/or. Nothing inside a string literal. */
export function filterHints(text: string, fields: FieldInfo[], target: Target): Hint[] {
  const { frag, head, before, prev } = split(text, /[\w']*$/);
  if ((head.split("'").length - 1) % 2 || (head.split('"').length - 1) % 2) return [];
  const byName = new Map(fields.map((f) => [f.name, f]));
  const p = prev.toLowerCase();
  const pool: Word[] =
    !prev || prev === "(" || ["and", "or", "not"].includes(p) ? [...fieldWords(fields), ...FUNCS[target].map(word)]
    : byName.has(prev) ? OPS[target].map(word)
    : OPS[target].includes(p) ? (byName.get(/(\w+)\s+\w+$/.exec(before)?.[1] ?? "")?.values ?? []).map(word)
    : prev === "," ? [] // a function's second argument: free text
    : ["and", "or"].map(word);
  return complete(head, frag, pool);
}
