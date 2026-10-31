# Marketing site (confire.ai) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Fiori-Horizon marketing site on `confire.ai`. It's static, in English, Spanish and
Basque, built for SEO and AI search, and its demo form mails the owner. It deploys separately from
the app.

**Architecture:** A new Astro workspace, `apps/site`, renders plain HTML/CSS with no framework JS. A
Bun prebuild script turns SAP's Horizon theme files into a pruned variable sheet, copies the 72 fonts
and extracts icon paths. The demo form posts to a new plain route on the portal process, which
awaits a Resend mail. Caddy serves the built files from a host directory that a site-only workflow
fills over SSH.

**Tech Stack:**
- Astro 7.4 and `@astrojs/sitemap` 3.7.
- `@sap-theming/theming-base-content` and `@ui5/webcomponents-icons` (assets only, no UI5 runtime).
- Hono and zod on the server, React Email for the mail.
- Bun test. `playwright-core` (dev only) for the browser checks and the placeholder images.
- Caddy 2 and GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-30-marketing-site-design.md`. The approved look is
`docs/superpowers/specs/2026-10-30-marketing-site-mockup.html`; port its CSS and markup faithfully.

## Global Constraints

- No UI5 Web Components and no framework runtime on the site. Pages are static HTML. The only JS
  is the consent script and Plausible (spec §5.1, §10).
- **Every colour is a SAP variable or a `color-mix()` of them.** No hex, rgb, hsl or named colour in
  site CSS. The only exception is `black` inside `mask-image` (§5.2).
- The SAP variables are those of `sap_horizon` (Morning) and `sap_horizon_dark` (Evening), following
  `prefers-color-scheme`. There's no toggle. The security section uses Evening via the `.evening`
  scope (§5.3).
- Display type: 72 Black at `clamp(2.5rem, 1.25rem + 4.6vw, 4.75rem)`, line-height 1.03, tracking
  −0.03em. Body text is 1rem. Fiori breakpoints S < 600, M 600–1023, L 1024–1439, XL ≥ 1440; page
  padding 1/2/2/3 rem; max width 76rem (§5.3).
- AI purple only where AI acts. AI text and icons use `--ai-ink` (§5.2).
- `prefers-reduced-motion: reduce` disables every animation and shows the end states (§5.6).
- Languages: `en` at `/`, `es` at `/es/`, `eu` at `/eu/`. Paths are English in every language,
  with a trailing slash. `x-default` is English. Never redirect on `Accept-Language` (§8).
- A missing translation is a build/type error, never a fallback (§8).
- `og:locale`: `en_GB`, `es_ES`, `eu_ES`. OG images are 1200×630 (§12).
- Astro `site` is `https://confire.ai`. Sign-in is `https://app.confire.ai/login`, and
  `http://localhost:5173/login` in dev (§7).
- Demo route: `POST /api/demo-request` on the **portal** process, form-encoded. It **awaits** the
  mail to `DEMO_INBOX`, from `notify@mail.<DOMAIN>`, with Reply-To set to the requester. Success is
  `303 /<lang>/thanks/` (§9).
- No third-party script before consent. Reject and Accept have equal weight. The choice lives in
  `localStorage` (§10).
- Budgets: ≤ 200 KB first-view transfer before consent; ≤ 2 preloaded fonts; Lighthouse mobile
  Perf ≥ 95, A11y/BP/SEO 100 (§12).
- The contact address is **undecided**. It's one config value that may be empty: never hard-code
  one (§15).
- The site deploys on its own (site workflow). The `Caddyfile`, compose and portal route ship with an
  app release (§11.2).

## Review Focus

1. **Switching language on a sub-page:** `/es/privacy/` → English must land on `/privacy/`, not `/`.
   A page missing in one language isn't offered in that language. (Task 5 dist test.)
2. **Submitting the form again:** a refresh or Back after sending must not re-send. That's the
   303→GET pattern, and a second POST within the hour from the same IP counts against the limit.
   (Task 1 test.)
3. **JavaScript off or the consent script failing:** the page and form fully work, the consent card
   stays hidden, nothing tracks. (Task 8 no-JS test.)
4. **Long Basque words on a 360px phone:** no horizontal scroll on `/eu/` in Morning or Evening.
   (Task 8 responsive test.)
5. **An address typed with spaces or capitals** (` Ana@Firma.ES `) is accepted and mailed trimmed;
   an empty or malformed address is refused. (Task 1 test.)

---

### Task 1: Demo request route on the portal process

**Files:**
- Modify: `apps/server/src/mail/mailer.ts`. Add `replyTo?: string` to `Mail` and `SentMail`, pass it
  to Resend as `replyTo`, and rewrite the header comment's "no Reply-To" sentence to name this one
  exception.
- Create: `apps/server/src/mail/demo-mail.tsx`
- Create: `apps/server/src/demo-request.ts`
- Modify: `apps/server/src/portal/index.ts` (mount the routes beside `fileRoutes("external")`)
- Modify: `docker-compose.yml` (`DEMO_INBOX: ${DEMO_INBOX:-}` in the `&app-env` block, with a comment)
- Test: `apps/server/test/demo-request.test.ts`

**Interfaces:**
- Produces:
  - `demoRoutes(opts?: { send?: (mail: Mail) => Promise<SendResult>; perHour?: number }): Hono`
    serves `POST /api/demo-request`. `send` defaults to `sendMail`, `perHour` to 5. The rate-limit
    window lives in the closure, so each `demoRoutes()` call has its own.
  - `DemoRequestMail(props: DemoRequest & { utm: Record<string, string> })`.
  - `type DemoRequest = { name: string; email: string; company: string; setup: string; message: string; lang: "en" | "es" | "eu" }`.

- [ ] **Step 1: Write the failing tests**

Each test builds `const app = demoRoutes({ send })` and posts
`new URLSearchParams({...}).toString()` with `content-type: application/x-www-form-urlencoded`,
`x-forwarded-for: <ip>` and `referer`. `process.env.DEMO_INBOX = "owner@example.com"` goes in
`beforeEach`.

```ts
test("a valid request mails the inbox and redirects to thanks", async () => {
  // fields: name "Ana", email " Ana@Firma.ES ", company "Firma", setup "SAP Business One + Beas",
  // message "Conveyors", lang "es"; referer "https://confire.ai/es/?utm_source=linkedin&utm_campaign=q4"
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/es/thanks/");
  const m = devOutbox.at(-1)!;
  expect(m.to).toBe("owner@example.com");
  expect(m.replyTo).toBe("Ana@Firma.ES");                 // trimmed, case kept
  expect(m.subject).toBe("Demo request: Firma (Ana)");
  expect(m.text).toContain("utm_source: linkedin");
  expect(m.text).toContain("SAP Business One + Beas");
});
test("english has no prefix", …)                           // lang "en" → location "/thanks/"
test("an unknown lang is english", …)                      // lang "fr" → "/thanks/"
test("the honeypot answers thanks and sends nothing", …)   // website: "x" → 303 "/thanks/", outbox length unchanged
test("an invalid address is refused", …)                   // email "nope" and email "" → 303 "/demo-error/", nothing sent
test("the sixth request in an hour from one IP is refused", …) // 5× → thanks; 6th → "/demo-error/"; another IP → thanks
test("a failed send is logged and shows the error page", …) // send: async () => ({ error: "boom" }); lang "eu"
  // → 303 "/eu/demo-error/"; spyOn(console, "error") called with a string containing "Ana@Firma.ES"
test("an unset DEMO_INBOX is a failed send", …)            // delete env → "/demo-error/", console.error mentions DEMO_INBOX
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test apps/server/test/demo-request.test.ts`
Expected: FAIL: `Cannot find module '../src/demo-request.ts'`.

- [ ] **Step 3: Implement**

- **zod schema:** `name`/`company` trimmed, 1–200; `email` trimmed, `z.email()`, ≤ 254; `setup`
  ≤ 100 and `message` ≤ 5000, both default `""`; `lang` falls back to `"en"`.
- **Order:** honeypot `website` → rate limit (key = first `x-forwarded-for` value, else `"unknown"`)
  → validate → `DEMO_INBOX` (read with `||`) → `await send(...)`.
- **Mail:** `utm_*` parsed from the `referer` header's query. `fromName: "Confire"`.
- **Locations:** use `localePrefix = lang === "en" ? "" : "/" + lang`.
- **On failure:**
  - `console.error("[demo-request] not delivered", JSON.stringify(fields), reason)`.
  - `Sentry.captureMessage("Demo request not delivered: " + reason)` **without** the fields:
    `instrument.ts` sends no PII.
- **Template:** `DemoRequestMail` renders the fields and UTM lines through `layout.tsx`'s `Layout`
  with `CONFIRE`.
- **Mounting:** in `portal/index.ts`,
  `routes: new Hono().route("/", fileRoutes("external")).route("/", demoRoutes())`.

- [ ] **Step 4: Run the tests and the server type-check**

Run: `bun test apps/server/test/demo-request.test.ts && bunx tsc -p apps/server/tsconfig.json --noEmit`
Expected: all pass, no type errors.

- [ ] **Step 5: Commit**

`git add apps/server/src/mail apps/server/src/demo-request.ts apps/server/src/portal/index.ts apps/server/test/demo-request.test.ts docker-compose.yml`
`git commit -m "feat(server): demo request route on the portal process"`

### Task 2: Same-site origin guard (spec §11.4)

`confire.ai` and `app.confire.ai` are the same *site*, so `SameSite=Lax` cookies ride along on a
form POST from the apex. That apex will run ad scripts. Any form-encodable non-GET endpoint is
exposed: `/api/openapi/*` (the comment in `serve.ts` assumes cross-site) and `/files/*` uploads.

**Files:**
- Modify: `apps/server/src/serve.ts`. Add an `origin: string` option. Before every route, refuse a
  request with **403** when all of these hold:
  - its method isn't GET/HEAD/OPTIONS;
  - it sends an `Origin` header that isn't `origin`;
  - its path isn't under `/api/auth/` (Better Auth checks its own `trustedOrigins`) and isn't
    `/api/demo-request` (the apex's form).

  A request without `Origin` passes: the agent's pairing call and curl send none. Fix the
  "arrives signed out" comment, which assumed cross-site.
- Modify: `apps/server/src/index.ts` (`origin: authUrl`) and `apps/server/src/portal/index.ts`
  (`origin: portalUrl`), both from `tenant.ts`.
- Test: `apps/server/test/origin-guard.test.ts`

**Interfaces:**
- Consumes: `serve()`'s returned `{ fetch }` (import the default export of `src/index.ts`; importing
  doesn't listen).

- [ ] **Step 1: Write the failing tests**

```ts
test("a POST from another origin is refused", async () => {
  const res = await staff.fetch(new Request("http://localhost:3000/api/openapi/me", {
    method: "POST", headers: { origin: "http://localhost:4321", "content-type": "application/x-www-form-urlencoded" }, body: "",
  }));
  expect(res.status).toBe(403);
});
test("same origin, no origin, and GET pass the guard", …)  // origin http://localhost:5173 → status !== 403; no origin → !== 403; GET with foreign origin → !== 403
test("Better Auth and the demo form are left to their own checks", …) // POST /api/auth/sign-out with foreign origin → not this guard's 403 body "Forbidden origin"
test("the session cookie is HttpOnly", …)  // makeUser-style sign-in via auth.api / handler: every Set-Cookie for session_token contains "HttpOnly"
```

The guard answers `403` with the body `Forbidden origin`, so the Better Auth case can tell the two
apart.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test apps/server/test/origin-guard.test.ts`
Expected: the first test FAILS (status is not 403).

- [ ] **Step 3: Implement the guard**: one `app.use("*", …)` at the top of `serve()`.

- [ ] **Step 4: Run the whole server suite** (it needs the dev db): `bun run test:server`
Expected: PASS. In particular, the existing route tests that send no `Origin` still pass.

- [ ] **Step 5: Commit**: `git commit -m "fix(server): refuse same-site cross-origin writes"` (serve.ts, both index files, the test)

### Task 3: `apps/site` scaffold and the theme prebuild

**Files:**
- Create: `apps/site/package.json`:
  - name `@confire/site`;
  - scripts `prebuild: bun scripts/prebuild.ts`, `dev: bun scripts/prebuild.ts && astro dev`,
    `build: bun scripts/prebuild.ts && astro build`, `preview: astro preview`;
  - deps `astro@^7.4.4`, `@astrojs/sitemap@^3.7.4`, `@sap-theming/theming-base-content`,
    `@ui5/webcomponents-icons` and `@ui5/webcomponents-base` (the icon modules import it; Bun's
    isolated install needs it direct);
  - devDeps `playwright-core`.
- Create: `apps/site/astro.config.ts`:
  - `site: "https://confire.ai"`, `trailingSlash: "always"`;
  - `i18n: { defaultLocale: "en", locales: ["en","es","eu"], routing: { prefixDefaultLocale: false } }`;
  - `vite.server.proxy["/api/demo-request"] = "http://localhost:3001"`.

  The sitemap integration comes in Task 5.
- Create: `apps/site/tsconfig.json` (extends `../../tsconfig.base.json`; includes `src/**/*.ts`,
  `scripts/**/*.ts`, `test/**/*.ts`, `.astro/types.d.ts`).
- Create: `apps/site/scripts/prebuild.ts`, which writes into `apps/site/src/generated/` (gitignored):
  - `sap.css`;
  - `icons.ts`;
  - `brand-contract.txt`;
  - `public/fonts/72-{Regular,Bold,Black,Light}.woff2`, also gitignored.

  It fails, naming each offence, on a raw colour or an unknown `--sap*` name.
- Create: `apps/site/scripts/prebuild.test.ts`
- Create: `apps/site/src/pages/index.astro`. For now a placeholder: one `<h1>` and the
  `src/generated/sap.css` import, which proves the pipeline.
- Modify: `.gitignore` (`apps/site/src/generated/`, `apps/site/public/fonts/`, `apps/site/.astro/`)
- Modify: root `package.json`:
  - `dev` adds `dev:site`;
  - `dev:site: bun --cwd apps/site dev`;
  - `build:site: bun --cwd apps/site build`;
  - `test:site: bun test apps/site`.

  Then run `bun install`.

**Interfaces:**
- Produces, in `scripts/prebuild.ts`, all exported:
  - `cssOf(astroSource: string): string`: the contents of every `<style>` block and `style="…"`
    attribute, joined.
  - `usedSapVars(css: string): string[]`: sorted unique names from `var(--sapX` (fallbacks allowed).
  - `themeVars(themeCss: string): Map<string, string>`: every `--sap*: value` from a
    `css_variables.css`.
  - `sapCss(names: string[], morning: Map<string,string>, evening: Map<string,string>): string`:
    `:root{…}` + `@media (prefers-color-scheme: dark){:root{…}}` + `.evening{…}`. It throws
    `Unknown SAP variables: a, b` for names missing in either theme.
  - `rawColours(css: string): string[]`: offending snippets. It flags hex, `rgb(a)`, `hsl(a)`,
    `hwb`, `lab`, `lch`, `oklab(`/`oklch(` **as colour values** (but `in oklab` inside `color-mix`
    is fine), and named colours. It ignores `transparent`, `currentColor`, and `black`/`white` inside
    a `mask-image`/`-webkit-mask-image` declaration.
  - `ICONS: readonly string[]`: the icon names. Start with those the mockup's sprite uses.
- Produces `src/generated/icons.ts`:
  `export const ICON_PATHS = { ai: "M4.774…", … } as const; export type IconName = keyof typeof ICON_PATHS;`.
  The paths are read with `(await import("@ui5/webcomponents-icons/dist/v5/<name>.js")).pathData`
  under Bun.
- Produces `src/generated/sap.css`. Pages import it before the site CSS.

- [ ] **Step 1: Write the failing tests** (`apps/site/scripts/prebuild.test.ts`)

```ts
test("usedSapVars finds names, with fallbacks, sorted and unique", () => {
  expect(usedSapVars("a{color:var(--sapTitleColor);b:var(--sapBrandColor, red);c:var(--sapTitleColor)}"))
    .toEqual(["sapBrandColor", "sapTitleColor"]);
});
test("cssOf takes style blocks and style attributes", () => {
  expect(cssOf(`<p style="color:var(--sapTextColor)"></p><style>a{b:c}</style>`)).toContain("color:var(--sapTextColor)");
  expect(cssOf(`<style>a{b:c}</style>`)).toContain("a{b:c}");
});
test("sapCss emits Morning, Evening by media, and the .evening scope", () => {
  const css = sapCss(["sapBrandColor"], new Map([["sapBrandColor", "#0070f2"]]), new Map([["sapBrandColor", "#0070f2"]]));
  expect(css).toContain(":root{--sapBrandColor:#0070f2}");
  expect(css).toContain("@media (prefers-color-scheme: dark){:root{--sapBrandColor:#0070f2}}");
  expect(css).toContain(".evening{--sapBrandColor:#0070f2}");
});
test("sapCss names unknown variables", () => {
  expect(() => sapCss(["sapNope"], new Map(), new Map())).toThrow("Unknown SAP variables: sapNope");
});
test("themeVars reads the real Horizon files", () => {
  // read @sap-theming/theming-base-content/content/Base/baseLib/sap_horizon/css_variables.css
  expect(themeVars(text).get("sapButton_Emphasized_Background")).toBe("#0070f2");
  expect(themeVars(text).size).toBeGreaterThan(1000);
});
test("rawColours flags raw colours and nothing else", () => {
  expect(rawColours("a{color:#fff}")).toHaveLength(1);
  expect(rawColours("a{color:rgb(0 0 0)}")).toHaveLength(1);
  expect(rawColours("a{color:white}")).toHaveLength(1);
  expect(rawColours("a{background:color-mix(in oklab, var(--sapBrandColor) 30%, transparent)}")).toEqual([]);
  expect(rawColours("a{mask-image:radial-gradient(black 25%, transparent 78%)}")).toEqual([]);
  expect(rawColours("a{color:currentColor;fill:currentColor}")).toEqual([]);
});
```

- [ ] **Step 2: Run them to verify they fail**: `bun test apps/site/scripts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `prebuild.ts`**. The main run:
  1. glob `src/**/*.{css,astro}`;
  2. `cssOf` the `.astro` files;
  3. lint with `rawColours`;
  4. `usedSapVars`;
  5. load both theme files via `Bun.resolveSync`;
  6. write `sap.css`, `brand-contract.txt` (one name per line), `icons.ts`;
  7. copy the fonts from `baseTheme/fonts/`;
  8. exit 1 with every offence listed.

- [ ] **Step 4: Verify**

Run: `bun test apps/site/scripts && bun run build:site && ls apps/site/dist/index.html`
Expected: tests PASS, the build succeeds and `dist/index.html` exists.

- [ ] **Step 5: Commit**: `git commit -m "feat(site): Astro workspace and the Horizon theme prebuild"`

### Task 4: Languages, URLs and the dictionaries

**Files:**
- Create: `apps/site/src/i18n/index.ts`, `en.ts`, `es.ts`, `eu.ts`
- Create: `apps/site/src/lib/urls.ts`
- Test: `apps/site/test/i18n.test.ts`

**Interfaces:**
- Produces, in `i18n/index.ts`:
  - `LANGS = ["en", "es", "eu"] as const`, `type Lang`;
  - `type Dict = Widen<typeof en>`, where every string leaf is `string`;
  - `dict: Record<Lang, Dict>`;
  - `OG_LOCALE: Record<Lang, string>`;
  - `isLang(x: unknown): x is Lang`.

  `es.ts`/`eu.ts` are `export const es: Dict = {…}`, so a missing or extra key is a type error.
- Produces, in `lib/urls.ts`:
  - `localePath(lang: Lang, path: string): string`: `localePath("es","/privacy/") === "/es/privacy/"`,
    `localePath("en","/") === "/"`;
  - `alternates(path: string, langs?: readonly Lang[]): { lang: Lang | "x-default"; href: string }[]`;
  - `appUrl(): string`: `import.meta.env.DEV ? "http://localhost:5173" : "https://app.confire.ai"`.
- Dictionary shape (add keys as later tasks need them):
  - `meta.{title,description}`;
  - `nav.*`;
  - `hero.*`, `why.*`, `how.*`, `product.*`, `security.*`;
  - `faq.items: {q,a}[]`;
  - `demo.*`, `footer.*`, `consent.*`;
  - `thanks.*`, `demoError.*`, `notFound.*`.

  English copy is the mockup's text. Spanish and Basque are full drafts. Put
  `// DRAFT: owner review (spec §15)` at the top of `es.ts` and `eu.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
test("localePath", () => {
  expect(localePath("en", "/")).toBe("/");
  expect(localePath("es", "/")).toBe("/es/");
  expect(localePath("eu", "/privacy/")).toBe("/eu/privacy/");
});
test("alternates lists every language and x-default→english", () => {
  expect(alternates("/privacy/").map((a) => a.href)).toEqual(["/privacy/", "/es/privacy/", "/eu/privacy/", "/privacy/"]);
  expect(alternates("/privacy/").at(-1)!.lang).toBe("x-default");
});
test("every english string exists, non-empty, in es and eu", () => {
  // walk leaves of dict.en; for es and eu the same path is a non-empty string; arrays have equal length
});
```

- [ ] **Step 2: Run to fail**: `bun test apps/site/test/i18n.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement**, then verify types: `bun --cwd apps/site astro sync && bunx tsc -p apps/site/tsconfig.json --noEmit`.
- [ ] **Step 4: Run**: `bun test apps/site/test/i18n.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit**: `git commit -m "feat(site): languages, URLs and dictionaries"`

### Task 5: Layout, SEO head, chrome, and the non-landing pages

**Files:**
- Create: `apps/site/src/site.config.ts`:
  ```ts
  export const SITE = {
    contactEmail: "", plausibleScript: "", metaPixelId: "",
    linkedinPartnerId: "", linkedinConversionId: "",
    social: { linkedin: "", instagram: "" },
  };
  ```
  Each value has a comment saying where it comes from (§15). Empty means that feature renders
  nothing.
- Create: `apps/site/src/styles/tokens.css` (the derived tokens and base), `components.css` (the
  shell bar, buttons, pane, tile, object status, panel, form, consent, footer). Port both from the
  mockup.
- Create: `apps/site/src/components/Icon.astro` (`name: IconName`, inline `<svg viewBox="0 0 16 16"><path d=…>`),
  `ShellBar.astro`, `Footer.astro`
- Create: `apps/site/src/layouts/Base.astro`
- Create: `apps/site/src/content.config.ts` (collection `legal`, glob `src/content/legal/**/*.md`,
  schema `{ title, description }`), and `src/content/legal/{en,es,eu}/{privacy,legal-notice,cookies}.md`.
  Placeholders mark every gap as `[TO COMPLETE: …]` (company data, NIF, address, contact).
- Create: `apps/site/src/pages/[...lang]/[legal].astro`, `[...lang]/thanks.astro`,
  `[...lang]/demo-error.astro`, `[...lang]/404.astro`, `robots.txt.ts`, `llms.txt.ts`. Move the
  placeholder to `[...lang]/index.astro`.
- Modify: `astro.config.ts`: add `sitemap({ i18n: { defaultLocale: "en", locales: { en: "en", es: "es", eu: "eu" } }, filter })`,
  excluding `/thanks/`, `/demo-error/` and `/404/` in every language.
- Test: `apps/site/test/dist.test.ts`. It reads `apps/site/dist`, so run `build:site` first. It
  skips with a message if `dist` is missing.

**Interfaces:**
- `Base.astro` props:
  - `lang: Lang`, `path: string` (language-neutral, e.g. `"/privacy/"`), `title: string`,
    `description: string`;
  - `noindex?: boolean`;
  - `langs?: readonly Lang[]`, defaulting to all. These are the languages this page exists in:
    hreflang and the language menu use only these;
  - `jsonLd?: object[]`;
  - `conversion?: boolean` (thanks page);
  - `ogImage?: string`, defaulting to `/og/<lang>.png`.
- What `Base.astro` renders:
  - `<html lang>` and `<meta name="color-scheme" content="light dark">`;
  - the canonical, hreflang and OG/Twitter tags (§12);
  - preloads for `/fonts/72-Regular.woff2` and `/fonts/72-Black.woff2`;
  - the `@font-face` rules (Light 300, Regular 400, Bold 700, Black 900 as family "72", plus
    "72-Bold"), with a metric-matched fallback;
  - a skip link, `ShellBar`, `<main id="main">`, `Footer`;
  - a `Consent` slot (Task 7);
  - `jsonLd` as `<script type="application/ld+json">`.
- Legal pages carry `BreadcrumbList` JSON-LD. `thanks`, `demo-error` and `404` are `noindex`.
  `demo-error` shows `SITE.contactEmail` as a `mailto:` only when it's non-empty; otherwise it shows
  "try again later".
- `robots.txt`:
  - `User-agent: *` / `Allow: /`;
  - explicit `Allow: /` groups for GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot,
    Claude-User, PerplexityBot, Perplexity-User, Google-Extended, Applebot-Extended;
  - `Sitemap: https://confire.ai/sitemap-index.xml`.
- `llms.txt`: `# Confire`, a one-line summary, then a `## <Language>` section per language with
  `- [title](url): description` per indexable page.

- [ ] **Step 1: Write the failing tests** (`dist.test.ts`; helpers `read(p)` and `$(html, selector-ish regex)`)

```ts
test.each([["index.html","en","https://confire.ai/"],["es/index.html","es","https://confire.ai/es/"],["eu/index.html","eu","https://confire.ai/eu/"]])(
  "%s has its language, canonical and alternates", (file, lang, url) => {
    const html = read(file);
    expect(html).toContain(`<html lang="${lang}"`);
    expect(html).toContain(`<link rel="canonical" href="${url}"`);
    for (const h of ["en","es","eu","x-default"]) expect(html).toMatch(new RegExp(`hreflang="${h}"`));
    expect(html).toContain(`og:locale" content="${({en:"en_GB",es:"es_ES",eu:"eu_ES"} as const)[lang]}"`);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
});
test("the language menu keeps the page", () => {
  const html = read("es/privacy/index.html");
  expect(html).toContain('href="/privacy/"'); expect(html).toContain('href="/eu/privacy/"');
});
test("every internal link resolves to a built file", …)  // collect href="/…" from all dist html; each maps to dist/<path>index.html or a file
test("utility pages are noindex and out of the sitemap", …) // thanks/demo-error/404 contain noindex; sitemap-0.xml lacks "/thanks/"
test("robots.txt welcomes the AI crawlers and names the sitemap", …)
test("llms.txt has a section per language", …)            // contains "## English", "## Español", "## Euskara"
test("no inline executable script", …)                    // every <script> without src has type="application/ld+json"
test("no raw colour in built CSS", …)                     // rawColours(each dist/_astro/*.css) is empty
```

- [ ] **Step 2: Run to fail**: `bun run build:site && bun test apps/site/test/dist.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Verify**: `bun run build:site && bun test apps/site`. Expected: PASS.
- [ ] **Step 5: Commit**: `git commit -m "feat(site): layout, SEO head, legal and utility pages"`

### Task 6: The landing page

**Files:**
- Create: `apps/site/src/components/landing/Hero.astro` (pill, headline, lead, CTAs, works-with,
  and the stage with its loop), `Why.astro`, `How.astro`, `Bento.astro`, `Security.astro` (the
  `.evening band`), `Faq.astro`, `Demo.astro`, `apps/site/src/styles/landing.css`.
- Modify: `apps/site/src/pages/[...lang]/index.astro`. It composes the sections and passes
  `jsonLd` = Organization, WebSite, SoftwareApplication (`applicationCategory: "BusinessApplication"`,
  `operatingSystem: "Web"`, no `offers`) and FAQPage built from `dict[lang].faq.items`.
  `Organization.sameAs` takes only the non-empty `SITE.social` values. `Organization.logo` is
  `https://confire.ai/logo.png` (Task 8).
- Modify: the dictionaries (all three) with the landing keys.
- Test: extend `apps/site/test/dist.test.ts`.

The port follows the mockup: markup, classes, CSS, keyframes, the reduced-motion and `@supports`
blocks, and `--ai-ink`.
- The stage is `role="img"` with the dictionary's one-sentence `aria-label`.
- The form is `method="post" action="/api/demo-request"`, with a hidden `lang` and a honeypot
  `website` (`tabindex="-1" autocomplete="off" aria-hidden="true"`, positioned off-screen).
- Every UI string comes from the dictionary, including the stage and tile fragments.

- [ ] **Step 1: Write the failing tests**

```ts
test.each(["index.html","es/index.html","eu/index.html"])("%s carries its structured data", (f) => {
  const types = ldJson(read(f)).map((o) => o["@type"]);
  expect(types).toEqual(expect.arrayContaining(["Organization","WebSite","SoftwareApplication","FAQPage"]));
});
test("the FAQ in JSON-LD matches the visible FAQ", …)   // FAQPage.mainEntity names === <summary> texts, same order
test("the form posts to the route with its language", …) // es page: action="/api/demo-request", method="post", name="lang" value="es", name="website"
test("first view stays under 200 KB gzipped before consent", …)
  // gzip(index.html) + gzip(each linked /_astro css/js) + the two preloaded fonts ≤ 200_000
test("at most two fonts are preloaded", …)
```

- [ ] **Step 2: Run to fail**: `bun run build:site && bun test apps/site/test/dist.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the sections and styles.
- [ ] **Step 4: Verify**: `bun run build:site && bun test apps/site`. Expected: PASS. Then open
  `bun --cwd apps/site preview` and compare `/` with the mockup in Morning and Evening.
- [ ] **Step 5: Commit**: `git commit -m "feat(site): landing page"`

### Task 7: Consent, pixels and Plausible

**Files:**
- Create: `apps/site/src/lib/consent.ts`, with pure logic and no DOM:
  - `type Choice = "granted" | "denied" | null`;
  - `type Pixels = { meta: string; linkedin: string }`;
  - `plan(choice: Choice, pixels: Pixels): { showCard: boolean; load: ("meta" | "linkedin")[] }`.
- Create: `apps/site/src/components/Consent.astro`. The card markup starts `hidden`. Reject and
  Accept are both `class="btn"`, side by side, Reject first. A bundled `<script>` reads and writes
  `localStorage["consent"]`, applies `plan`, injects `connect.facebook.net/en_US/fbevents.js` (init
  + `PageView`) and/or `snap.licdn.com/li.lms-analytics/insight.min.js`, and fires `fbq("track","Lead")`
  / `lintrk("track",{conversion_id})` when `<body data-conversion>`. The footer's
  `[data-consent-open]` button reopens it. Withdrawing a granted consent stores `denied` and reloads.
- Modify: `Base.astro`. Render `Consent` only when a pixel ID is set. Add
  `<script defer data-domain="confire.ai" src={SITE.plausibleScript}>` only when it's set.
  `thanks.astro` passes `conversion`.
- Test: `apps/site/test/consent.test.ts`, and extend `dist.test.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
const both = { meta: "1", linkedin: "2" }, none = { meta: "", linkedin: "" };
test("no choice yet: ask, load nothing", () => expect(plan(null, both)).toEqual({ showCard: true, load: [] }));
test("granted: load what is configured", () => expect(plan("granted", { meta: "1", linkedin: "" })).toEqual({ showCard: false, load: ["meta"] }));
test("denied: load nothing", () => expect(plan("denied", both)).toEqual({ showCard: false, load: [] }));
test("no pixel configured: never ask", () => expect(plan(null, none)).toEqual({ showCard: false, load: [] }));
// dist.test.ts
test("no third-party host in the built HTML before consent", …) // with empty SITE ids: no "facebook", "licdn" in any dist html
```

- [ ] **Step 2: Run to fail**: `bun test apps/site/test/consent.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Verify**: `bun run build:site && bun test apps/site`. Expected: PASS.
- [ ] **Step 5: Commit**: `git commit -m "feat(site): consent card, ad pixels after consent, Plausible"`

### Task 8: Browser checks and placeholder brand assets

**Files:**
- Create: `apps/site/scripts/assets.ts`. Run with `CHROME=<chromium path> bun apps/site/scripts/assets.ts`.
  It renders `apps/site/scripts/assets.html?lang=<l>&kind=<og|logo|touch>` with `playwright-core`
  and writes `public/og/{en,es,eu}.png` (1200×630), `public/logo.png` (512²) and
  `public/apple-touch-icon.png` (180²). The HTML uses `src/generated/sap.css`, the 72 fonts and the
  hero headline per language. Also create `public/favicon.svg`, the "C" mark: an asset, so a literal
  brand colour is allowed there.
- Commit the generated PNGs.
- Create: `apps/site/test/browser.test.ts`. It skips unless `CHROME` is set. It starts
  `astro preview` on a free port, then:
  - for widths 360, 390, 768, 1024, 1440, 1920 × `colorScheme` light/dark × pages `/`, `/es/`, `/eu/`,
    `/privacy/`: `document.documentElement.scrollWidth <= innerWidth`;
  - with `javaScriptEnabled: false` on `/`: the `<h1>` is visible, the form's submit button is
    visible, and the consent card is hidden;
  - with `reducedMotion: "reduce"`: `.stage .fill` has computed opacity `1`.

- [ ] **Step 1: Write the failing test** (as above). Run: `CHROME=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome bun test apps/site/test/browser.test.ts`
  Expected: FAIL. Any overflow is reported with the page, width and scheme.
- [ ] **Step 2: Fix the overflows or failures it finds** in the site CSS.
- [ ] **Step 3: Generate the assets**, and check that `dist.test.ts`'s link test now resolves
  `/og/*.png`, `/logo.png` and `/favicon.svg`.
- [ ] **Step 4: Verify**: `bun run build:site && CHROME=… bun test apps/site`. Expected: PASS.
- [ ] **Step 5: Commit**: `git commit -m "feat(site): responsive and no-JS checks, placeholder brand assets"`

### Task 9: Serving and shipping

**Files:**
- Modify: `Caddyfile`. Replace the apex redirect with the spec's §11.1 block:
  - `encode zstd gzip`;
  - `handle /api/demo-request { reverse_proxy portal:3001 }`;
  - a `handle` over `root * /srv/site/current` with `try_files {path} {path}/index.html` and
    `file_server`;
  - `Cache-Control`: `/_astro/*` immutable for a year; `/fonts/*` and `/og/*` a week; HTML `no-cache`;
  - headers: CSP, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and
    `Permissions-Policy`.

  The CSP: `default-src 'self'`; `script-src 'self'` + the Plausible, `connect.facebook.net` and
  `snap.licdn.com` hosts; `connect-src`/`img-src` add `www.facebook.com`, `px.ads.linkedin.com` and
  Plausible; `style-src 'self' 'unsafe-inline'` (Astro inlines small CSS, and the visuals use
  `style=`); `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`.

  Add `handle_errors 404` with mutually exclusive `rewrite`s to `/es/404/index.html`,
  `/eu/404/index.html`, else `/404/index.html`, then `file_server`. Add `www.{$DOMAIN}` →
  `redir https://{$DOMAIN}{uri} permanent`. Rewrite the header comment and drop the ponytail line.
- Modify: `docker-compose.yml`, service `caddy`: add the volume `../site:/srv/site:ro`
  (`/home/deploy/site` on the server) with a comment.
- Create: `deploy/site.sh`, the forced command of a second key:
  1. `SSH_ORIGINAL_COMMAND` must match `^[0-9a-f]{7,40}$`;
  2. stdin is a gzipped tar of `dist`;
  3. extract to `$HOME/site/releases/<sha>.tmp`, then `mv` to `<sha>`;
  4. `ln -sfn releases/<sha> $HOME/site/current.tmp && mv -T $HOME/site/current.tmp $HOME/site/current`;
  5. keep the 5 newest releases;
  6. print `site <sha> live`.
- Test: `apps/site/test/deploy.test.ts`. It runs `sh deploy/site.sh` with `HOME=<tmpdir>` and a tar
  on stdin, then asserts:
  - `current` → `releases/abc1234`;
  - a 6th deploy prunes the oldest;
  - `SSH_ORIGINAL_COMMAND="x; rm -rf /"` exits non-zero and changes nothing.
- Create: `.github/workflows/site.yml`:
  - triggers `workflow_dispatch`; concurrency `site`;
  - `actions/setup-node` (Node 24) and `oven-sh/setup-bun`;
  - `bun install --frozen-lockfile`, `bun run build:site`;
  - `bun test apps/site` with `CHROME=$(which google-chrome)`;
  - `tar -C apps/site/dist -czf - . | ssh deploy@"$HOST" "$GITHUB_SHA"`, using secrets
    `SITE_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` and variable `DEPLOY_HOST`.

  Comment how to add `push: { branches: [main], paths: [apps/site/**] }` once push-to-deploy
  returns.
- Modify: `DEPLOY.md`:
  - §2: an optional `www` A/AAAA record;
  - §6: the second key, `command="/home/deploy/confire/deploy/site.sh",restrict … github-site`,
    and the secret `SITE_SSH_KEY`;
  - a new "The marketing site" section: first launch order (app deploy with the Caddyfile, compose
    and demo route → site workflow → `docker compose up -d --force-recreate caddy`), `DEMO_INBOX` in
    `.env`, rollback (`ln -sfn releases/<old> current.tmp && mv -T …` on the server), Search Console
    and Bing Webmaster (DNS TXT, submit the sitemap), Plausible, LinkedIn Post Inspector and Meta
    Sharing Debugger, and the Lighthouse release check
    (`bunx lighthouse https://confire.ai/ --form-factor=mobile` ≥ 95/100/100/100 for `/`, `/es/`, `/eu/`);
  - §10: the `Caddyfile` row now also covers the apex.
- Modify: `CLAUDE.md`:
  - Commands: `bun run dev` also starts the site on `:4321`; add `build:site` and `test:site`; the
    type-check project list gains `apps/site`, with `astro sync` first.
  - A short "The marketing site" section: `apps/site`, the theme prebuild and brand contract, the
    colour rule, the dictionaries, the separate deploy and the demo route.
  - The `Caddyfile`/apex sentence in "Tenancy is the path": the apex now serves the site.

- [ ] **Step 1: Write the failing deploy test**, then run it: `bun test apps/site/test/deploy.test.ts`. Expected: FAIL (no script).
- [ ] **Step 2: Implement `deploy/site.sh`**, then run the test again. Expected: PASS.
- [ ] **Step 3: Write the Caddyfile, compose, workflow and docs changes.**
- [ ] **Step 4: Verify the Caddyfile**: `docker run --rm -v $PWD/Caddyfile:/etc/caddy/Caddyfile -e DOMAIN=confire.ai caddy:2 caddy validate --config /etc/caddy/Caddyfile`.
  Expected: `Valid configuration`. If the Docker socket is denied here (see memory), say so and
  leave this check to the server's first `--force-recreate caddy`.
- [ ] **Step 5: Run every gate**: `bun run test:site && bun test apps/server/test/demo-request.test.ts apps/server/test/origin-guard.test.ts && bunx tsc -p apps/server/tsconfig.json --noEmit && bun --cwd apps/site astro sync && bunx tsc -p apps/site/tsconfig.json --noEmit`.
  Expected: PASS.
- [ ] **Step 6: Commit**: `git commit -m "feat(site): serve from Caddy, site-only deploy, docs"`
