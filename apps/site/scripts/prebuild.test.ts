import { expect, test } from "bun:test";
import { cssOf, rawColours, sapCss, themeVars, usedSapVars } from "./prebuild.ts";

test("usedSapVars finds names, with fallbacks, sorted and unique", () => {
  expect(usedSapVars("a{color:var(--sapTitleColor);b:var(--sapBrandColor, red);c:var(--sapTitleColor)}"))
    .toEqual(["sapBrandColor", "sapTitleColor"]);
});

test("cssOf takes style blocks and style attributes", () => {
  expect(cssOf(`<p style="color:var(--sapTextColor)"></p><style>a{b:c}</style>`)).toContain("color:var(--sapTextColor)");
  expect(cssOf(`<style>a{b:c}</style>`)).toContain("a{b:c}");
  expect(cssOf(`<style is:global>\na{b:c}\n</style>`)).toContain("a{b:c}");
});

test("sapCss emits Morning, Evening by media, and the .evening scope", () => {
  const css = sapCss(["sapBrandColor"], new Map([["sapBrandColor", "#0070f2"]]), new Map([["sapBrandColor", "#0070f2"]]));
  expect(css).toContain(":root{--sapBrandColor:#0070f2}");
  expect(css).toContain("@media (prefers-color-scheme: dark){:root{--sapBrandColor:#0070f2}}");
  expect(css).toContain(".evening{--sapBrandColor:#0070f2}");
});

test("sapCss names unknown variables", () => {
  expect(() => sapCss(["sapNope", "sapBrandColor"], new Map([["sapBrandColor", "x"]]), new Map()))
    .toThrow("Unknown SAP variables: sapNope, sapBrandColor");
});

test("themeVars reads the real Horizon files", async () => {
  const path = Bun.resolveSync("@sap-theming/theming-base-content/content/Base/baseLib/sap_horizon/css_variables.css", import.meta.dir);
  const vars = themeVars(await Bun.file(path).text());
  expect(vars.get("sapButton_Emphasized_Background")).toBe("#0070f2");
  expect(vars.get("sapFontFamily")).toBe(`"72", "72full", Arial, Helvetica, sans-serif`);
  expect(vars.size).toBeGreaterThan(1000);
});

test("rawColours flags raw colours and nothing else", () => {
  expect(rawColours("a{color:#fff}")).toHaveLength(1);
  expect(rawColours("a{color:rgb(0 0 0)}")).toHaveLength(1);
  expect(rawColours("a{color:white}")).toHaveLength(1);
  expect(rawColours("a{background:oklch(70% .1 200)}")).toHaveLength(1);
  expect(rawColours("a{background:color-mix(in oklab, var(--sapBrandColor) 30%, transparent)}")).toEqual([]);
  expect(rawColours("a{mask-image:radial-gradient(black 25%, transparent 78%)}")).toEqual([]);
  expect(rawColours("a{-webkit-mask-image:radial-gradient(black 25%, transparent 78%)}")).toEqual([]);
  expect(rawColours("a{color:currentColor;fill:currentColor}")).toEqual([]);
  // selectors, urls, strings and variable names are not colours
  expect(rawColours(`#faded, .spark.blue{background:var(--sapRedColor)} @font-face{src:url(/fonts/72-Black.woff2);font-family:"72-Black"}`)).toEqual([]);
});
