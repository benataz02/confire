import { expect, test } from "bun:test";
import { preloadFonts } from "./preloadFonts.ts";

const cdn = "https://cdn.jsdelivr.net/npm/@sap-theming/theming-base-content@11.36.4/content/Base/baseLib/baseTheme/fonts";

test("preloads the frame's three 72 weights from the bundle's own URLs, once each", () => {
  const code = `src:url(${cdn}/72-Regular.woff2) a;src:url(${cdn}/72-Bold.woff2)\`;src:url(${cdn}/72-Black.woff2);src:url(${cdn}/72-Light.woff2);src:url(${cdn}/72-Regular.woff2)`;
  const tags = preloadFonts().transformIndexHtml.handler("", { bundle: { a: { type: "chunk", code }, b: { type: "asset" } } });
  expect(tags.map((t) => t.attrs.href)).toEqual([`${cdn}/72-Regular.woff2`, `${cdn}/72-Bold.woff2`, `${cdn}/72-Black.woff2`]);
  expect(tags[0]!.attrs).toMatchObject({ rel: "preload", as: "font", crossorigin: "" });
});

test("dev has no bundle: nothing to preload", () => {
  expect(preloadFonts().transformIndexHtml.handler("", {})).toEqual([]);
});
