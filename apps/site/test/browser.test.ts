import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";

// The built site in a real browser (spec 2026-10-30 §12): no horizontal scroll at any Fiori width in
// either theme, a page that works with JavaScript off, and reduced motion showing end states.
// Needs `bun run build:site` and CHROME=<a Chromium executable>; skips otherwise.

const DIST = new URL("../dist/", import.meta.url).pathname;
const run = Boolean(process.env.CHROME) && existsSync(`${DIST}index.html`);
if (!run) console.warn("browser tests skipped: set CHROME and run `bun run build:site` first");
const t = run ? test : test.skip;

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  if (!run) return;
  // Caddy's try_files {path} {path}/index.html over dist, in-process.
  server = Bun.serve({ port: 0, fetch: async (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const file = Bun.file(DIST + (path.endsWith("/") ? `${path}index.html` : path).slice(1));
    return (await file.exists()) ? new Response(file) : new Response(Bun.file(`${DIST}404/index.html`), { status: 404 });
  } });
  browser = await chromium.launch({ executablePath: process.env.CHROME });
});
afterAll(async () => {
  await browser?.close();
  server?.stop();
});

t("no horizontal scroll at any width, in Morning or Evening", async () => {
  const overflows: string[] = [];
  for (const colorScheme of ["light", "dark"] as const) {
    for (const width of [360, 390, 768, 1024, 1440, 1920]) {
      const page = await browser.newPage({ viewport: { width, height: 800 }, colorScheme });
      for (const path of ["/", "/es/", "/eu/", "/privacy/", "/eu/cookies/", "/eu/thanks/"]) {
        await page.goto(new URL(path, server.url).href);
        const extra = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        if (extra > 0) overflows.push(`${path} at ${width}px, ${colorScheme}: ${extra}px too wide`);
      }
      await page.close();
    }
  }
  expect(overflows).toEqual([]);
}, 120_000);

t("with JavaScript off the page and the form work, and nothing asks for consent", async () => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(server.url.href);
  expect(await page.locator("h1").isVisible()).toBe(true);
  await page.locator("#demo").scrollIntoViewIfNeeded();
  expect(await page.locator("#demo button[type=submit]").isVisible()).toBe(true);
  expect(await page.locator(".consent").isVisible()).toBe(false);
  // the native popover menu needs no script either
  await page.setViewportSize({ width: 390, height: 800 });
  await page.click("button[popovertarget=menu]");
  expect(await page.locator("#menu").isVisible()).toBe(true);
  await context.close();
});

t("reduced motion shows the loop's end state", async () => {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  await page.goto(server.url.href);
  const opacities = await page.locator(".stage .fill").evaluateAll((els) => els.map((e) => getComputedStyle(e).opacity));
  expect(opacities).toEqual(["1", "1", "1", "1"]);
  expect(await page.locator(".stage .quote .os").evaluate((e) => getComputedStyle(e).opacity)).toBe("1");
  await page.close();
});
