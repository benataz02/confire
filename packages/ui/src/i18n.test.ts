import { expect, test } from "bun:test";

// UI5's .properties parser reads `window` on import; nothing else here needs a DOM.
(globalThis as { window?: unknown }).window ??= globalThis;
const { messageLoaders } = await import("./i18n.ts");

test("each language is laid over English, so an untranslated key reads in English", async () => {
  const loaders = messageLoaders({
    "./i18n/messagebundle_en.properties": async () => "# a comment\nNAV_HOME=Home\nUSER_MENU_DENSITY=Density",
    "./i18n/messagebundle_pt_BR.properties": async () => "NAV_HOME=Início",
  });
  expect(Object.keys(loaders).sort()).toEqual(["en", "pt_BR"]);
  expect(await loaders.pt_BR!()).toEqual({ NAV_HOME: "Início", USER_MENU_DENSITY: "Density" });
  expect(await loaders.en!()).toEqual({ NAV_HOME: "Home", USER_MENU_DENSITY: "Density" });
});
