import { registerI18nLoader } from "@ui5/webcomponents-base/dist/asset-registries/i18n.js";
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

/** One loader per `messagebundle_<locale>.properties` (`pt_BR`: UI5's locale ids use `_`). Each
 *  language is laid over English: UI5 loads one locale's file and shows a key that file lacks as
 *  the key itself, so a text nobody has translated yet reads in English instead. */
export function messageLoaders(files: Files) {
  const byLocale: Files = {};
  for (const [path, load] of Object.entries(files)) byLocale[/messagebundle_(\w+)\.properties$/.exec(path)![1]!] = load;
  const read = async (load: () => Promise<string>) => parse(await load()) as Record<string, string>;
  const loaders: Record<string, () => Promise<Record<string, string>>> = {};
  for (const [locale, load] of Object.entries(byLocale)) {
    loaders[locale] = async () => ({ ...(await read(byLocale.en!)), ...(await read(load)) });
  }
  return loaders;
}

/** Registers an app's bundle and returns its hook. `files` is the app's own
 *  `import.meta.glob("./i18n/messagebundle_*.properties", { query: "?raw", import: "default" })`:
 *  the glob has to sit in the app, and each file becomes a lazy chunk fetched only for its language. */
export function messageBundle(name: string, files: Files) {
  for (const [locale, loader] of Object.entries(messageLoaders(files))) registerI18nLoader(name, locale, loader);
  // The remembered choice is applied here, at startup: before UI5 boots it only records the language,
  // where a switch once the page has rendered re-fetches every bundle and redraws.
  const chosen = localStorage.getItem("language");
  if (chosen && !getLanguage()) void applyLanguage(chosen);
  return () => useI18nBundle(name);
}

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
