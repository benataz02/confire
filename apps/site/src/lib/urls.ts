import { LANGS, type Lang } from "../i18n/index.ts";

// Paths are English in every language, with a trailing slash: /privacy/, /es/privacy/ (spec §8).

export const localePath = (lang: Lang, path: string) => (lang === "en" ? path : `/${lang}${path}`);

/** The hreflang set of a page that exists in `langs`; x-default is English, when there is one. */
export const alternates = (path: string, langs: readonly Lang[] = LANGS): { lang: Lang | "x-default"; href: string }[] => [
  ...langs.map((lang) => ({ lang, href: localePath(lang, path) })),
  ...(langs.includes("en") ? [{ lang: "x-default" as const, href: localePath("en", path) }] : []),
];

/** The staff app, where Sign in goes (spec §7): a build setting, like `site`. */
export const appUrl = () => (import.meta.env.DEV ? "http://localhost:5173" : "https://app.confire.ai");
