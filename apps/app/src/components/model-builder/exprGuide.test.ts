import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FUNCS } from "@confire/config-engine";
import { EXPR_GUIDE_KEYS, FUNC_GUIDE } from "./exprGuide.ts";

describe("exprGuide", () => {
  test("lists every formula function and nothing the engine does not have", () => {
    expect(FUNC_GUIDE.map((f) => f.name).sort()).toEqual([...FUNCS].sort());
    for (const f of FUNC_GUIDE) {
      expect(f.sig.startsWith(`${f.name}(`)).toBe(true);
      expect(f.example.startsWith(`${f.name}(`)).toBe(true);
    }
  });

  test("every guide text exists in English, Spanish and Basque", () => {
    for (const loc of ["en", "es", "eu"]) {
      const text = readFileSync(new URL(`../../i18n/parts/model.${loc}.properties`, import.meta.url), "utf8");
      const keys = new Set(text.split("\n").map((line) => line.split("=", 1)[0]));
      for (const key of EXPR_GUIDE_KEYS) expect(keys, `${loc} ${key}`).toContain(key);
    }
  });
});
