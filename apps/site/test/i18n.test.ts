import { expect, test } from "bun:test";
import { dict, isLang, money } from "../src/i18n/index.ts";
import { alternates, localePath } from "../src/lib/urls.ts";

test("localePath", () => {
  expect(localePath("en", "/")).toBe("/");
  expect(localePath("es", "/")).toBe("/es/");
  expect(localePath("eu", "/privacy/")).toBe("/eu/privacy/");
});

test("alternates lists every language and x-default→english", () => {
  expect(alternates("/privacy/").map((a) => a.href)).toEqual(["/privacy/", "/es/privacy/", "/eu/privacy/", "/privacy/"]);
  expect(alternates("/privacy/").at(-1)!.lang).toBe("x-default");
  // a page only in Spanish has no English to default to
  expect(alternates("/x/", ["es"])).toEqual([{ lang: "es", href: "/es/x/" }]);
});

test("isLang", () => {
  expect(["en", "es", "eu", "fr", undefined].map(isLang)).toEqual([true, true, true, false, false]);
});

test("money is the language's own format", () => {
  expect(money("en", 18450)).toBe("€18,450");
  expect(money("es", 18450)).toBe("18.450\u00a0€"); // a no-break space: the figure never wraps
});

/** Every string leaf of `o`, by path; arrays by index. */
function leaves(o: unknown, path = ""): [string, unknown][] {
  if (o && typeof o === "object") return Object.entries(o).flatMap(([k, v]) => leaves(v, `${path}.${k}`));
  return [[path, o]];
}

test("every english string exists, non-empty, in es and eu", () => {
  const en = leaves(dict.en);
  for (const lang of ["es", "eu"] as const) {
    const other = new Map(leaves(dict[lang]));
    expect([...other.keys()].sort()).toEqual(en.map(([p]) => p).sort()); // same arrays, same lengths
    for (const [p] of en) {
      const v = other.get(p);
      if (typeof v !== "string" || !v.trim()) throw new Error(`${lang}${p} is empty`);
    }
  }
});

test("highlight markers match across languages", () => {
  const marks = (s: string) => s.match(/\[[^\]]+\]/g)?.length ?? 0;
  for (const lang of ["es", "eu"] as const) {
    expect(marks(dict[lang].hero.stage.body)).toBe(marks(dict.en.hero.stage.body));
  }
});
