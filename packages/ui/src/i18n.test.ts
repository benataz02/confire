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

test("part files for one language merge, and that language still lays over English", async () => {
  const loaders = messageLoaders({
    "./i18n/messagebundle_en.properties": async () => "NAV_HOME=Home",
    "./i18n/parts/shell.en.properties": async () => "NAV_SETTINGS=Settings",
    "./i18n/parts/shell.es.properties": async () => "NAV_SETTINGS=Configuración",
  });
  expect(await loaders.en!()).toEqual({ NAV_HOME: "Home", NAV_SETTINGS: "Settings" });
  expect(await loaders.es!()).toEqual({ NAV_HOME: "Home", NAV_SETTINGS: "Configuración" });
});

test("the first render shows the texts, never their keys", async () => {
  (globalThis as { localStorage?: unknown }).localStorage ??= { getItem: () => null };
  const { messageBundle, textsLoaded } = await import("./i18n.ts");
  const { createElement } = await import("react");
  const { renderToString } = await import("react-dom/server");
  const useTexts = messageBundle("@confire/test", { "./i18n/messagebundle_en.properties": async () => "HELLO=Hello" });
  await textsLoaded();
  // renderToString runs no effects: what it returns is the first paint.
  expect(renderToString(createElement(() => useTexts().getText("HELLO")))).toBe("Hello");
});
