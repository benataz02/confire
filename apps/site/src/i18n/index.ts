import { en } from "./en.ts";
import { es } from "./es.ts";
import { eu } from "./eu.ts";

// English at /, Spanish at /es/, Basque at /eu/ (spec 2026-10-30 §8). English's shape is every
// language's type, so a missing translation is a type error, never a fallback.

export const LANGS = ["en", "es", "eu"] as const;
export type Lang = (typeof LANGS)[number];
/** en.ts is a plain (non-const) literal, so its leaves are already `string`. */
export type Dict = typeof en;

export const dict: Record<Lang, Dict> = { en, es, eu };
/** Each language in itself: the menus and llms.txt. */
export const LANG_NAMES: Record<Lang, string> = { en: "English", es: "Español", eu: "Euskara" };
export const OG_LOCALE: Record<Lang, string> = { en: "en_GB", es: "es_ES", eu: "eu_ES" };
const INTL: Record<Lang, string> = { en: "en-GB", es: "es-ES", eu: "eu" };

export const isLang = (x: unknown): x is Lang => LANGS.includes(x as Lang);

/** A whole-euro figure in the language's own format: €18,450 / 18.450 €. */
export const money = (lang: Lang, n: number) =>
  new Intl.NumberFormat(INTL[lang], { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
