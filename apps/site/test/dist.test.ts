import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { rawColours } from "../scripts/prebuild.ts";

// Reads the built site: run `bun run build:site` first (CI does, spec 2026-10-30 §12).

const DIST = new URL("../dist/", import.meta.url).pathname;
const built = existsSync(`${DIST}index.html`);
if (!built) console.warn("apps/site/dist is missing: run `bun run build:site` first; skipping the dist tests");
const t = built ? test : test.skip;

const read = (p: string) => readFileSync(DIST + p, "utf8");
const files = (dir = ""): string[] => readdirSync(DIST + dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? files(`${dir}${e.name}/`) : [`${dir}${e.name}`]));
const html = () => files().filter((f) => f.endsWith(".html"));
const ldJson = (h: string) => [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!));
/** The file a site URL path serves (Caddy: try_files {path} {path}/index.html). */
const fileOf = (path: string) => (path.endsWith("/") ? `${path}index.html` : path).slice(1);

t.each([["index.html", "en", "https://confire.ai/"], ["es/index.html", "es", "https://confire.ai/es/"], ["eu/index.html", "eu", "https://confire.ai/eu/"]])(
  "%s has its language, canonical and alternates", (file, lang, url) => {
    const h = read(file);
    expect(h).toContain(`<html lang="${lang}"`);
    expect(h).toContain(`<link rel="canonical" href="${url}"`);
    for (const l of ["en", "es", "eu", "x-default"]) expect(h).toMatch(new RegExp(`hreflang="${l}"`));
    expect(h).toContain(`og:locale" content="${({ en: "en_GB", es: "es_ES", eu: "eu_ES" } as Record<string, string>)[lang]}"`);
    expect(h.match(/<h1[\s>]/g)).toHaveLength(1);
  });

t("every page has one h1, a title and a description", () => {
  for (const f of html()) {
    const h = read(f);
    expect([f, h.match(/<h1[\s>]/g)?.length]).toEqual([f, 1]);
    expect(h).toMatch(/<title>[^<]+<\/title>/);
    expect(h).toMatch(/<meta name="description" content="[^"]+"/);
  }
});

t("the language menu keeps the page", () => {
  const h = read("es/privacy/index.html");
  expect(h).toContain('href="/privacy/"');
  expect(h).toContain('href="/eu/privacy/"');
  expect(h).toContain('<link rel="alternate" hreflang="en" href="https://confire.ai/privacy/"');
});

t("every internal link resolves to a built file", () => {
  const missing = new Set<string>();
  for (const f of html()) {
    const h = read(f);
    const paths = [
      ...[...h.matchAll(/\s(?:href|src)="(\/[^"#?]*)/g)].map((m) => m[1]!),
      ...[...h.matchAll(/content="https:\/\/confire\.ai(\/[^"#?]*)"/g)].map((m) => m[1]!),
    ].filter((p) => !p.startsWith("/api/"));
    for (const p of paths) if (!existsSync(DIST + fileOf(p))) missing.add(`${f} → ${p}`);
  }
  expect([...missing]).toEqual([]);
});

t("utility pages are noindex and out of the sitemap", () => {
  for (const lang of ["", "es/", "eu/"]) {
    for (const page of ["thanks", "demo-error", "404"]) expect(read(`${lang}${page}/index.html`)).toContain('<meta name="robots" content="noindex"');
  }
  const sitemap = read("sitemap-0.xml");
  for (const page of ["thanks", "demo-error", "404"]) expect(sitemap).not.toContain(`/${page}/`);
  expect(sitemap).toContain("https://confire.ai/eu/privacy/");
  expect(sitemap).toContain('hreflang="es"');
});

t("robots.txt welcomes the AI crawlers and names the sitemap", () => {
  const robots = read("robots.txt");
  for (const bot of ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "Claude-User", "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended"]) {
    expect(robots).toContain(`User-agent: ${bot}\nAllow: /`);
  }
  expect(robots).toContain("Sitemap: https://confire.ai/sitemap-index.xml");
  expect(robots).not.toContain("Disallow");
});

t("llms.txt has a section per language", () => {
  const llms = read("llms.txt");
  expect(llms.startsWith("# Confire\n")).toBe(true);
  for (const s of ["## English", "## Español", "## Euskara"]) expect(llms).toContain(s);
  expect(llms).toContain("(https://confire.ai/es/privacy/)");
  expect(llms).not.toContain("thanks");
});

t("no inline executable script", () => {
  for (const f of html()) {
    for (const m of read(f).matchAll(/<script([^>]*)>/g)) {
      if (!/\ssrc=/.test(m[1]!)) expect([f, m[1]]).toEqual([f, ' type="application/ld+json"']);
    }
  }
});

t("no raw colour in built CSS", () => {
  // The minifier writes `transparent` as #0000 and a mask's `black` as #000: the same allowed values.
  const allowed = (css: string) => css.replace(/#0000(?![0-9a-f])/gi, "transparent")
    .replace(/mask-image:[^;}]*/g, (m) => m.replace(/#000(?![0-9a-f])/gi, "black"));
  for (const f of files("_astro/").filter((f) => f.endsWith(".css"))) expect([f, rawColours(allowed(read(f)))]).toEqual([f, []]);
});

t.each(["index.html", "es/index.html", "eu/index.html"])("%s carries its structured data", (f) => {
  const types = ldJson(read(f)).map((o) => o["@type"]);
  expect(types).toEqual(expect.arrayContaining(["Organization", "WebSite", "SoftwareApplication", "FAQPage"]));
});

t("the FAQ in JSON-LD matches the visible FAQ", () => {
  for (const f of ["index.html", "es/index.html", "eu/index.html"]) {
    const h = read(f);
    const faq = ldJson(h).find((o) => o["@type"] === "FAQPage");
    const visible = [...h.matchAll(/<summary>([^<]+)</g)].map((m) => m[1]!.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    expect(faq.mainEntity.map((q: { name: string }) => q.name)).toEqual(visible);
  }
});

t("legal pages carry a breadcrumb", () => {
  const crumbs = ldJson(read("eu/cookies/index.html")).find((o) => o["@type"] === "BreadcrumbList");
  expect(crumbs.itemListElement.map((i: { item: string }) => i.item)).toEqual(["https://confire.ai/eu/", "https://confire.ai/eu/cookies/"]);
});

t("the form posts to the route with its language", () => {
  const h = read("es/index.html");
  expect(h).toContain('<form method="post" action="/api/demo-request"');
  expect(h).toMatch(/<input type="hidden" name="lang" value="es"/);
  expect(h).toMatch(/<input class="trap" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"/);
});

t("first view stays under 200 KB gzipped before consent", () => {
  const h = read("index.html");
  const assets = [...h.matchAll(/(?:href|src)="(\/_astro\/[^"]+\.(?:css|js))"/g)].map((m) => m[1]!);
  const fonts = [...h.matchAll(/<link rel="preload" href="([^"]+)" as="font"/g)].map((m) => m[1]!);
  const bytes = gzipSync(h).length + assets.reduce((n, a) => n + gzipSync(readFileSync(DIST + a.slice(1))).length, 0)
    + fonts.reduce((n, f) => n + readFileSync(DIST + f.slice(1)).length, 0);
  expect(bytes).toBeLessThanOrEqual(200_000);
});

t("at most two fonts are preloaded", () => {
  for (const f of html()) expect((read(f).match(/as="font"/g) ?? []).length).toBeLessThanOrEqual(2);
});

t("no third-party host in the built HTML before consent", () => {
  for (const f of html()) expect([f, /facebook|licdn|linkedin\.com\/li|plausible/.test(read(f))]).toEqual([f, false]);
});
