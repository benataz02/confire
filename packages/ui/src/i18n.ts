import { registerI18nLoader } from "@ui5/webcomponents-base/dist/asset-registries/i18n.js";
import I18nBundle, { getI18nBundle } from "@ui5/webcomponents-base/dist/i18nBundle.js";
import { getLanguage, setFetchDefaultLanguage, setLanguage as applyLanguage } from "@ui5/webcomponents-base/dist/config/Language.js";
import getLocale from "@ui5/webcomponents-base/dist/locale/getLocale.js";
import parse from "@ui5/webcomponents-base/dist/PropertiesFileFormat.js";
import { useI18nBundle } from "@ui5/webcomponents-react-base/hooks";
import { useState } from "react";

// UI5's i18n (webcomponents-react Knowledge Base > Internationalization). The language is UI5's:
// ?sap-ui-language=es, else the user menu's choice (useLanguage), else the browser's. UI5's own
// components carry their English inline and skip fetching it; a custom bundle has none, so without
// this English would render as bare keys.
setFetchDefaultLanguage(true);

type Files = Record<string, () => Promise<string>>;

/** `messagebundle_<locale>.properties`, or a part file `name.<locale>.properties` (`pt_BR`: UI5's
 *  locale ids use `_`). Several files for one locale merge in path order; each language is then
 *  laid over English. UI5 loads one locale and shows a key that file lacks as the key itself, so
 *  a text nobody has translated yet reads in English instead. */
export function localeOf(path: string): string | undefined {
  return /messagebundle_(\w+)\.properties$/.exec(path)?.[1] ?? /\.([a-z]{2}(?:_[A-Z]{2})?)\.properties$/.exec(path)?.[1];
}

export function messageLoaders(files: Files) {
  const byLocale: Record<string, [string, () => Promise<string>][]> = {};
  for (const [path, load] of Object.entries(files)) {
    const locale = localeOf(path);
    if (locale) (byLocale[locale] ??= []).push([path, load]);
  }
  for (const group of Object.values(byLocale)) group.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const read = async (load: () => Promise<string>) => parse(await load()) as Record<string, string>;
  const merged = async (locale: string) => {
    const out: Record<string, string> = {};
    for (const [, load] of byLocale[locale] ?? []) Object.assign(out, await read(load));
    return out;
  };
  const loaders: Record<string, () => Promise<Record<string, string>>> = {};
  for (const locale of Object.keys(byLocale)) {
    loaders[locale] = async () => (locale === "en" ? merged("en") : { ...(await merged("en")), ...(await merged(locale)) });
  }
  return loaders;
}

const loading: Promise<unknown>[] = [];

/** Every registered bundle's texts are in. Each app's i18n.ts awaits it, so nothing renders before. */
export const textsLoaded = () => Promise.all(loading);

// UI5's useI18nBundle returns an empty bundle (getText gives back the key) until its own effect has
// fetched the texts, after the first paint: every load flashed its keys. The texts are in before the
// first render (textsLoaded) and getText reads them when called, so hand out the real bundle at once;
// UI5's hook stays for its subscription, which re-renders on a language change.
const hookFor = (name: string) => {
  const bundle = new I18nBundle(name);
  return () => {
    useI18nBundle(name);
    return bundle;
  };
};

/** Registers an app's bundle and returns its hook. `files` is the app's own
 *  `import.meta.glob("./i18n/messagebundle_*.properties", { query: "?raw", import: "default" })`:
 *  the glob has to sit in the app, and each file becomes a lazy chunk fetched only for its language. */
export function messageBundle(name: string, files: Files) {
  for (const [locale, loader] of Object.entries(messageLoaders(files))) registerI18nLoader(name, locale, loader);
  // The remembered choice is applied here, at startup: before UI5 boots it only records the language,
  // where a switch once the page has rendered re-fetches every bundle and redraws.
  const chosen = localStorage.getItem("language");
  if (chosen && !getLanguage()) void applyLanguage(chosen);
  loading.push(getI18nBundle(name)); // after the language: it fetches the current one
  return hookFor(name);
}

/** Shared shells (List Report, Object Page, value help). Each app registers `@confire/ui`
 *  from packages/ui/src/i18n in its own i18n.ts — the glob has to sit in the app. */
export const useUiI18n = hookFor("@confire/ui");

// Each language in its own name, so a user finds theirs whatever the page is showing.
export const LANGUAGES = [
  { id: "en", label: "English" },
  { id: "es", label: "Español" },
] as const;

/** The user menu's language, remembered per browser like theme and density (appearance.ts). */
export function useLanguage() {
  const [language, setState] = useState(() => getLocale().getLanguage());
  const setLanguage = (id: string) => {
    localStorage.setItem("language", id);
    setState(id);
    void applyLanguage(id);
  };
  return { language, setLanguage };
}
