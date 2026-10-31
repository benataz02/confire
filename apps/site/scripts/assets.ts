import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { dict, LANGS } from "../src/i18n/index.ts";

// Renders the placeholder brand assets from scripts/assets.html (spec §13.1) into public/: one share
// image per language (1200×630, the hero's headline), the logo (512²) and the touch icon (180²).
// Run after a prebuild, and commit the PNGs:
//   CHROME=~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome bun apps/site/scripts/assets.ts

const root = new URL("..", import.meta.url).pathname;
const executablePath = process.env.CHROME;
if (!executablePath) throw new Error("Set CHROME to a Chromium executable");

// http, not file://: Chromium refuses a file:// page its file:// fonts.
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const file = Bun.file(root + decodeURIComponent(new URL(req.url).pathname).slice(1));
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 });
  },
});
const browser = await chromium.launch({ executablePath });
try {
  await mkdir(`${root}public/og`, { recursive: true });
  const shots = [
    ...LANGS.map((lang) => ({ out: `og/${lang}.png`, w: 1200, h: 630, q: { kind: "og", lang, t: dict[lang].hero.title, ai: dict[lang].hero.titleAi } })),
    { out: "logo.png", w: 512, h: 512, q: { kind: "logo" } },
    { out: "apple-touch-icon.png", w: 180, h: 180, q: { kind: "touch" } },
  ];
  for (const { out, w, h, q } of shots) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, colorScheme: "light" });
    await page.goto(`${server.url}scripts/assets.html?${new URLSearchParams(q)}`);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${root}public/${out}`, omitBackground: q.kind === "logo" });
    await page.close();
    console.log(`public/${out}`);
  }
} finally {
  await browser.close();
  server.stop();
}
