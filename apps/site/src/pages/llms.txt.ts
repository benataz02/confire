import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { dict, LANG_NAMES, LANGS } from "../i18n/index.ts";
import { localePath } from "../lib/urls.ts";

// llms.txt (spec §12): every indexable page per language. Low expectations — assistants do not pick
// citations from it, coding agents read it — but it costs nothing.
export const GET: APIRoute = async ({ site }) => {
  const legal = await getCollection("legal");
  const url = (p: string) => new URL(p, site).href;
  const sections = LANGS.map((lang) => {
    const t = dict[lang];
    const pages = [
      `- [${t.meta.title}](${url(localePath(lang, "/"))}): ${t.meta.description}`,
      ...legal.filter((e) => e.id.startsWith(`${lang}/`))
        .map((e) => `- [${e.data.title}](${url(localePath(lang, `/${e.id.slice(lang.length + 1)}/`))}): ${e.data.description}`),
    ];
    return `## ${LANG_NAMES[lang]}\n\n${pages.join("\n")}`;
  });
  return new Response(`# Confire\n\n> ${dict.en.meta.description}\n\n${sections.join("\n\n")}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
