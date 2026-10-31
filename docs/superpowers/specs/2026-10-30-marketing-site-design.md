# The marketing site: confire.ai

2026-10-30. Status: design, not built. The approved look is
`2026-10-30-marketing-site-mockup.html` (beside this file). It loads SAP's theme files, the 72 fonts
and an icon sprite from `/files/…`: the brainstorm companion served those, so opened on its own it
falls back to system fonts and no colours. Section 5 says where each one comes from.

## 1. Why

Today `confire.ai` only redirects to sign-in (`Caddyfile`: *"ponytail: the apex only redirects until a
marketing site exists"*). Confire is about to be sold through LinkedIn, Instagram and other Meta ads,
through Google and Bing, and through AI assistants answering "is there an AI quoting tool for SAP
Business One?". All of them need a page that says what Confire is, and one way to ask for a demo.

**Who lands on it:** the CEO, CTO, head of sales or a salesperson at a small or mid-sized
manufacturer running SAP Business One (often with Beas). They like tools and are already looking at
AI for their own workflows. They want to see early that it works with *their* SAP setup and is not a
generic AI pitch. The CTO reads the security section and the FAQ.

**The one job:** get them to **request a demo / more information**. Every section leads there.
**Success** is demo requests from that audience, not traffic.

## 2. Goals

1. A landing page that feels special while staying recognisably **SAP Fiori (Horizon)**:
   Morning Horizon (`sap_horizon`) and Evening Horizon (`sap_horizon_dark`), following the visitor's
   system setting.
2. **English, Spanish and Basque**, each on its own indexable URL.
3. **SEO**: everything a search engine needs is in the HTML (titles, descriptions, canonical,
   hreflang, sitemap, structured data).
4. **AI search ("agent SEO")**: being found and quoted by ChatGPT, Claude and Perplexity.
5. **Social and ads**: correct link previews on LinkedIn, Facebook and Instagram, and ad conversion
   measurement with the LinkedIn Insight Tag and the Meta Pixel, after consent.
6. **Visitor analytics**: visits, sources, campaigns and pages read, for every visitor.
7. **Very responsive**, phone first: much of the ad traffic (all of Instagram's) is mobile.
8. **A demo form** whose requests reach the owner as an email.
9. **Rebrandable**: the owner will soon replace SAP's blue with Confire's own brand using SAP's CSS
   variables. That must be a one-file change (section 5.2).
10. **Cheap to grow**: it will gain customer stories, solution pages and integration pages, each in
    three languages, written by the owner in the repo.

## 3. Non-goals (for now)

- Agents acting on the site (booking demos, reading an API). Being *read* by AI is a goal; being
  *used* by it isn't.
- A CMS. The owner edits content in code.
- Pricing, a blog, sign-up from the site, live chat, a calendar booking widget.
- A theme toggle. The site follows the system setting (see §13).
- Server-side ad conversion APIs (Meta Conversions API, LinkedIn CAPI).
- Anything from the current auth pages (`/login`, onboarding). The owner dislikes their design;
  **nothing is taken from them**, including the Fraunces font they load from Google Fonts.

## 4. Anti-goals: what makes it a failure even if it works

- **Content drawn by JavaScript.** If a crawler without JS sees an empty page or empty custom
  elements, the site has failed its main job.
- **Losing a demo request.** A request that silently vanishes is worse than an error the visitor sees.
- **A mixed-language page.** Spanish text with an English sentence left in it, served under `/es/`.
- **A raw colour anywhere.** It breaks the rebrand and Evening Horizon.
- **Tracking before consent.** Spain's AEPD fines this. Reject must be as easy as Accept.
- **A slow page.** Ad clicks on phones abandon slow pages, and every second costs money.
- **Weakening the app's cookie boundary.** The apex receives the session cookie (§11.4).
- **Generic SaaS look.** It must read as Fiori and as built for SAP Business One manufacturers.

## 5. Look and feel: Fiori Horizon without UI5

### 5.1 No UI5 Web Components

UI5 Web Components draw themselves in the browser only. SAP has no server-rendering support for them
(ui5-webcomponents issue #6192, ui5-webcomponents-react issue #194), so a crawler would see empty
tags. The site uses **none** of them. The Fiori look comes straight from SAP's own assets, already in
`node_modules`:

| Asset | Source |
|---|---|
| Theme variables | `@sap-theming/theming-base-content`: `content/Base/baseLib/sap_horizon/css_variables.css` and `…/sap_horizon_dark/css_variables.css` |
| 72 font | same package, `content/Base/baseLib/baseTheme/fonts/72-{Regular,Bold,Black,Light}.woff2` (~24 KB each) |
| Icons | `@ui5/webcomponents-icons/dist/v5/<name>.js`, each exporting `pathData` (16×16 viewBox, the Horizon set), inlined as SVG at build time |

The theme files are not usable as they stand. Each declares `@font-face` rules for the SAP icon fonts
with relative URLs, plus a metadata class, and carries about 1,537 variables (~100 KB, ~12 KB
gzipped). The build keeps **only the custom properties the site's CSS actually uses** (§5.2) and
emits them three times:

- `:root`: Morning
- `@media (prefers-color-scheme: dark) { :root { … } }`: Evening
- `.evening { … }`: Evening for one section inside a Morning page (the security band)

The result is small enough to inline in the page `<head>`. `<meta name="color-scheme" content="light dark">`.

### 5.2 The colour rule and the brand contract

**Every colour is a SAP variable, or a `color-mix()` of SAP variables with `transparent` or with each
other.** No hex, rgb or named colour appears in the site's CSS. The one exception is `black` inside
`mask-image`, which is alpha, not colour. The build fails on a raw colour (§12).

Why: Horizon's variables are pre-computed. Only 3 of the 1,537 reference another variable.
`--sapButton_Emphasized_Background` is its own `#0070f2`, so overriding `--sapBrandColor` alone
recolours nothing. **The set of variables the site uses is therefore the brand contract.** The mockup
uses 62 of them (`sapBrandColor`, the `sapButton_*` family, `sapAssistant_*`, `sapTitleColor`,
`sapContent_LabelColor`, `sapChart_OrderedColor_{1,2,6}`, …). A future `brand.css` overrides exactly
that list for both themes. The build should write the list out (e.g. `brand-contract.txt`), so the
owner knows what to set.

Derived tokens the mockup defines, recomputed per scope (`body` and `.evening`), because a custom
property holding `var()` resolves where it is declared:

| Token | Definition | Use |
|---|---|---|
| `--glow-brand` | `color-mix(in oklab, var(--sapBrandColor) 30%, transparent)` | background glows, button glow |
| `--glow-ai` | same with `--sapAssistant_Background` 24% | AI glows |
| `--ai-ink` | `color-mix(in oklab, var(--sapAssistant_Background) 62%, var(--sapTitleColor))` | **AI text and icons.** Raw `--sapAssistant_Background` is unreadable on Evening; mixing toward the title colour lightens it there and darkens it slightly on Morning |
| `--ai-wash` / `--brand-wash` | 14% / 12% washes | chips, highlights, icon backgrounds |
| `--dot` | `--sapContent_LabelColor` 26% | the dot grid |
| `--hairline` | `--sapList_BorderColor` 80% | borders |
| `--glass` | `--sapGroup_ContentBackground` 72% | frosted surfaces (shell bar, stage, consent) |

### 5.3 Visual language (as approved)

- **Type:** 72 throughout. The **display headline** is 72 Black at
  `clamp(2.5rem, 1.25rem + 4.6vw, 4.75rem)`, line-height 1.03, tracking −0.03em. That is larger than
  Fiori's 3rem H1 on purpose: marketing needs a display size. Section titles are 72 Bold,
  `clamp(1.75rem, 1rem + 2.2vw, 2.75rem)`, tracking −0.025em. **Body text is 1rem**
  (`--sapFontLargeSize`), because Fiori's 0.875rem is for apps, not reading. UI chrome (buttons,
  labels, tables) keeps `--sapFontSize`. Above each section title sits an uppercase **eyebrow** (0.75rem,
  700, letter-spacing 0.14em, `--sapHighlightColor`). Headings use `text-wrap: balance`.
- **AI is purple, and only AI is purple.** The `--sapAssistant_*` gradient and `--ai-ink` appear
  only where the AI acts: ✦ marks (the `ai` icon, never the ✦ character, which 72 lacks), the "In
  minutes." gradient text, AI chips and tiles. This is the same rule as the app.
- **Surfaces:** page `--sapBackgroundColor`, hero and alternate sections `--sapShellColor`, tiles
  `--sapTile_Background` with a hairline border and 1.5rem radius. Inner "UI" panes use 1–1.125rem
  radius; buttons use `--sapButton_BorderCornerRadius`, and large CTAs 0.75rem. Shadows are
  `--sapContent_Shadow0`/`2` plus soft brand-tinted drop shadows built with `color-mix`.
- **Atmosphere:** a faint dot grid (22px, like engineering paper) masked to fade out, and two
  blurred radial glows (brand blue left, AI purple right) behind the hero, the security band and
  the CTA.
- **The security band is Evening Horizon even on a Morning page** (the `.evening` scope). It's a
  dark, premium break in the scroll and still pure Horizon.
- **Layout:** Fiori breakpoints. S < 600px, M 600–1023, L 1024–1439, XL ≥ 1440. Page padding is
  1rem / 2rem / 2rem / 3rem. Content max width 76rem. Sections are spaced
  `clamp(4.5rem, 3rem + 6vw, 8rem)` vertically.

### 5.4 Components (all hand-built HTML and CSS, styled as their Fiori namesakes)

Shell bar (sticky, frosted) · Buttons: Emphasized, Default, Transparent ("lite"), large · Announcement
pill · Pane (a framed piece of product UI with an uppercase header) · Tile (bento) · Object status
(Positive, Information, Critical, Negative, AI) · Field rows with ✦ · Option list with radio,
selected and disabled-with-reason states · Mini table · Stacked cost bars in `sapChart_OrderedColor_*`
· Status pulse dot · Panel (FAQ on `<details>`) · Form fields (Horizon field colours, 0.625rem
radius, focus ring = `--sapField_Focus_BorderColor` + a brand wash halo) · Consent card · Footer.

The menu on phones and the language menu are **native `popover`** elements, so they need no
JavaScript.

### 5.5 Product visuals are HTML, not screenshots

The hero stage and every bento tile draw small pieces of Confire **in HTML and CSS**: the request
email, the configuration, the SAP quotation, the rule list, the cost bars, the portal list. They are
**not** screenshots. A screenshot would need 3 languages × 2 themes = 6 images per visual, and it
blurs on retina, can't animate, and weighs far more. HTML visuals translate with the page, follow
Morning and Evening, and cost almost nothing. Each visual is decorative to assistive technology:
give it `role="img"` and an `aria-label` that tells its story in one sentence, as the mockup does.
Their figures are illustrative and must stay plausible (see §15).

### 5.6 Motion

- **The hero loop** (10s, infinite) tells the product in one pass:
  1. The email's values highlight.
  2. A purple ✦ travels the first connector ("AI reads").
  3. The configuration's values fade in one by one.
  4. The first option is selected.
  5. A blue marker travels the second connector ("Posted").
  6. The SAP quotation lifts and its **Posted** status pops.

  Connectors run horizontally from L up and vertically below it.
- **Scroll reveal** is CSS only: `animation-timeline: view()` inside `@supports`. Where unsupported,
  content is simply there.
- **Small things:** tiles lift on hover, button arrows nudge, FAQ panels open smoothly
  (`::details-content` + `interpolate-size`), the tunnel line flows, and the status dot pings.
- **`prefers-reduced-motion: reduce` turns all of it off** and shows each animation's end state.

## 6. The landing page, section by section

The mockup is the reference for layout and draft copy. All copy is a first draft by Claude: the owner
writes the final text.

1. **Shell bar:** logo mark + "Confire" (the "C" square is a placeholder until branding), links (How
   it works, Product, Security, FAQ), language menu, Sign in (`https://app.<domain>/login`), **Book a
   demo**. Below L: logo, Book a demo, menu.
2. **Hero:**
   - An announcement pill (AI news, links to the product section).
   - The display headline, ending in "In minutes." in AI gradient.
   - A one-sentence lead that says what Confire is.
   - **Book a demo** and **See how it works** buttons.
   - A "Works with" row: SAP Business One, Beas Manufacturing, SAP HANA, Microsoft SQL Server.
   - The stage, a frosted frame holding three panes: Customer request → Configuration → SAP Business
     One quotation (§5.6).
3. **Why Confire:** "Today" vs "With Confire" in two cards, each with three steps and a big time
   figure. The "With Confire" card has a brand→AI gradient border.
4. **How it works:** 01 Connect your SAP, 02 Model your products, 03 Quote. Each has a small chip,
   joined by a gradient line from M up.
5. **Product (bento):** six tiles, each with a working-looking UI fragment.
   - Large: **Reads the request, asks what's missing** (AI).
   - Small: **Only valid combinations** (rules).
   - Small: **Real costs, every quantity** (cost bars).
   - Large: **Posted straight to SAP Business One** (quotation lines + "Never posted twice").
   - Half: **Keeps quoting when SAP is down**.
   - Half: **A portal for your customers**.

   Grid: 6 columns from 1100px, 2 columns from 700px, 1 below.
6. **Security** (Evening band): "Your SAP stays on your server". It makes three points (no SAP
   passwords in the cloud, an allowlist, no inbound ports) beside an architecture drawing: Confire
   (EU) → encrypted outbound tunnel → your network (agent, SAP Business One).
7. **FAQ:** a sticky title column on L and up, six `<details>` panels. **Each answer's first sentence
   answers the question outright.** That sentence is what AI assistants quote.
8. **Demo:** the CTA card with a gradient border.
   - Left: "See it on one of your own products" and the three next steps.
   - Right: the form. Name*, Work email*, Company*, Your setup (SAP Business One / + Beas / Something
     else), "What do you quote today?", a hidden honeypot, **Request a demo**.
9. **Footer:**
   - Brand line.
   - Product, Company and Legal columns.
   - Languages.
   - "SAP and SAP Business One are trademarks of SAP SE. Confire is not affiliated with SAP."
10. **Consent card** (§10).

## 7. Technology

| Use | Why |
|---|---|
| **Astro** (current major), new workspace `apps/site` | Builds plain HTML at build time and ships no JavaScript unless a component asks for it. Has i18n routing, content collections for Markdown pages, image optimisation and a sitemap integration |
| Plain CSS on SAP variables (§5) | One design system, the theme's own |
| Bun, like the rest of the repo | `bun --cwd apps/site build` |

**Not used:**

| Skip | Why |
|---|---|
| UI5 Web Components | invisible to crawlers (§5.1) |
| Next.js, TanStack Start, React on the page | they ship a framework to hydrate a page that has nothing to hydrate |
| Tailwind or any CSS framework | a second design system fighting SAP's variables |
| A CMS | the owner edits in code |
| Google Fonts or any font CDN | GDPR (German courts have ruled embedding them a breach) and speed; fonts are self-hosted |
| A hosted consent platform, form service or captcha | §9 and §10 cover them in a few lines |

**The site has a build setting, unlike the SPAs.** The SPAs read their origins from `location`
(`@confire/ui/host.ts`). A static site can't: canonical URLs, hreflang, the sitemap and `og:url`
must be absolute in the HTML. Astro's `site` is set at build time (`https://confire.ai`), and the
Sign-in link derives from it (`https://app.confire.ai/login`). In dev, it's the localhost URLs.

## 8. Languages, URLs and content

- `en` at the root (`/`), `es` at `/es/`, `eu` at `/eu/` (Astro `prefixDefaultLocale: false`).
  `x-default` is English. **`/` never redirects by `Accept-Language`**, because crawlers would only
  ever see one language. A visitor switches languages from the menu, which keeps them on the same
  page.
- Each page links its alternates with `<link rel="alternate" hreflang>` (written in the layout:
  Astro doesn't generate them), and the sitemap carries them too. `og:locale` is `en_GB` / `es_ES` /
  `eu_ES`, plus `og:locale:alternate`.
- **Landing-page copy** lives in one typed dictionary per language (`src/i18n/en.ts`, `es.ts`,
  `eu.ts`). English's shape is the type, so **a missing translation is a build error**, never a
  fallback (§4).
- **Long-form pages** are Markdown per language in Astro content collections: legal pages now,
  solutions, integrations and customer stories later. They're linked across languages by a shared
  `translationKey` in the frontmatter. A page that exists in only one language has no alternates and
  isn't linked from the others' language menu.
- Pages built now: `/`, `/thanks/` (after the form), `/privacy/`, `/legal-notice/`, `/cookies/`, a
  404, each × 3 languages. Paths stay English in every language (`/es/privacy/`). My call: simpler
  links, negligible SEO cost.
- Future page types (`/solutions/<slug>/`, `/integrations/<slug>/`, `/customers/<slug>/`) get their
  collection and layout when their first page is written. **No empty scaffolding now.** The nav gains
  a link when a type has a page.

## 9. The demo request

- The form is a plain HTML `POST` to **`/api/demo-request`**, form-encoded. It works with JavaScript
  off. It carries a hidden `lang` and the honeypot `website`.
- **The route lives on the portal process** (`apps/server/src/portal/index.ts` → `serve()`'s
  `routes`). That process exists so external traffic never shares an event loop with staff
  (`CLAUDE.md`). Caddy sends the apex's `/api/demo-request` there (§11).
- Handling:
  1. If the honeypot is filled, answer success and send nothing.
  2. Rate-limit per client IP to a few per hour. Read the IP from Caddy's `X-Forwarded-For`, and trust
     that header only because Caddy is the only way in. Reuse the fixed-window shape of
     `assistant/usage.ts`' `rateLimit`. It's per process, which is fine here.
  3. Validate with zod.
  4. **Await** `sendMail` (`apps/server/src/mail/mailer.ts`): to the address in a new env
     **`DEMO_INBOX`** (still undecided, §15), from `notify@mail.<DOMAIN>`, `replyTo` the requester. The mail carries every
     field, the language, and the campaign: the POST's `Referer` is the page URL including its `utm_*`
     parameters, because same-origin requests send the full URL under `strict-origin-when-cross-origin`.
  5. On success, answer **303 to `/<lang>/thanks/`**.
- **A failed send is not fire-and-forget here.** That's unlike the rest of the app's mail, because
  this mail is the only record. On failure:
  1. Log the whole request at error level (Sentry has it).
  2. Answer an error page in the visitor's language: "Something went wrong. Write to us at …" with a
     `mailto:` to the **public contact address**.

  That address, the footer's *Contact* and the legal notice's contact email are one value in the
  site's config, never repeated in pages. It isn't chosen yet, and `confire.ai` receives no mail today
  (no MX). See §15.

  `// ponytail: no table; a demo_request table when requests need a status or a CRM.`
- Dev: no `RESEND_API_KEY` = the console mailer, as everywhere. The Astro dev server proxies
  `/api/demo-request` to `:3001`.
- No captcha (the app has no bot check either). The honeypot and the rate limit come first, and
  Turnstile only if spam actually arrives.

## 10. Consent, ads and analytics

- **Consent card:** bottom-right, frosted. **Reject and Accept have equal weight** (same style, same
  size, side by side). There's no pre-ticked box and no "by continuing you accept". The choice is
  stored in `localStorage` (strictly necessary, no cookie). The footer's *Cookies* link reopens it, so
  withdrawing is as easy as giving. The `/cookies/` page lists each third-party cookie.
- **Before consent, no third-party script loads.** Accept injects the **Meta Pixel** and the
  **LinkedIn Insight Tag**: PageView on every page, and the *Lead* / conversion event on `/thanks/`.
  Reject loads nothing.
- **Visitor analytics: Plausible** (the owner's choice, about €9 a month). EU-owned and EU-hosted,
  cookieless, no personal data, so it needs no consent and counts every visitor. It reports sources,
  `utm_*` campaigns and pages read, with a "Demo request" goal on `/thanks/`. Optionally proxy its
  script and event endpoint through Caddy, so ad blockers don't hide visits.
- The consent script plus the Plausible script is **all the JavaScript a visitor gets before
  consenting** (a few KB).

## 11. Hosting and deploy

### 11.1 Served by Caddy, as files

The built site is static files served by **Caddy itself**, not by a Bun process. A crashed or
restarting app must not take the marketing site down. The apex block in `Caddyfile` changes from the
redirect to:

- `encode zstd gzip`.
- `/api/demo-request` → `reverse_proxy portal:3001`. Optionally also the analytics proxy paths.
- Everything else: `file_server` over the site's `dist`, with `try_files {path} {path}/index.html`, and
  `handle_errors` serving the right language's 404.
- Cache: `/_astro/*` (hashed) `public, max-age=31536000, immutable`, HTML `no-cache`.
- Headers: `Content-Security-Policy` (`script-src 'self'` + the Plausible host + the Meta and
  LinkedIn hosts, which load only after consent), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`.
- `www.<DOMAIN>` → redirect to the apex. That needs a DNS record; see DEPLOY.md.

Update the `Caddyfile` header comment and drop its ponytail note.

### 11.2 Shipping: the site deploys on its own (my call)

**A copy fix must never be an app release.** Today an app release means:
- `deploy.yml` builds the image and `update.sh` recreates `server` and `portal` and runs migrations;
- it only happens when `main` is releasable, and today it isn't (push-to-deploy is off and the work
  branch is far ahead).

A marketing site gets edited often, and the ads can't wait for the app. So the site has **its own
workflow** (`.github/workflows/site.yml`; manual dispatch, plus push to `main` touching `apps/site/**`
once push-to-deploy returns):

1. Build `apps/site`.
2. Run the site's gates (§12). They never block an app release, and an app release never waits for
   them.
3. Copy `dist` to the server over the SSH access `deploy.yml` already uses (same `deploy` user and
   secrets) into `site/releases/<sha>/`.
4. Switch a `site/current` symlink to it in one atomic step (`ln -sfn` to a temp name, then
   `mv -T`), and keep the last few releases for rollback.

The stock `caddy:2` container mounts `site/` read-only, and its root is `…/current`. There is no image
and no Caddy restart. The `Caddyfile` change (§11.1) still ships through the normal app flow, once,
together with the demo route on the portal process: both are app changes. DEPLOY.md gains the
site's deploy and rollback steps.

### 11.3 Dev

`bun run dev` gains `dev:site` (Astro's dev server). The root `package.json` gains `build:site`.

### 11.4 The cookie boundary

`CLAUDE.md`: *every `*.confire.ai` host receives the session cookie*, and the apex does too. The site
is served by this stack, so that rule holds. But after consent the apex now runs **third-party
scripts** (Meta, LinkedIn). The builder must check three things:

1. The session cookie stays `HttpOnly`.
2. No JS-readable cookie on `<DOMAIN>` carries anything sensitive.
3. The apex's CSP is as tight as §11.1.

`confire.ai` and `app.confire.ai` are *same-site*, so a compromised ad script could send same-site
requests to the app. Confirm that the app's state-changing endpoints refuse a cross-origin caller:
oRPC's JSON calls need a CORS preflight that is never granted, and Better Auth checks `Origin`. Fix
any that don't.

## 12. SEO, AI search and quality gates

**Every page, every language:**
- A unique `<title>` and meta description.
- A self-referencing canonical, hreflang alternates and `x-default`.
- One `<h1>`, semantic landmarks, `lang` on `<html>`.
- `og:title`, `og:description`, `og:url`, `og:type`, `og:site_name`, `og:image` (1200×630) +
  `og:image:alt`, `og:locale` (+ alternates), and `twitter:card=summary_large_image`.
- A favicon (SVG) + a 180px Apple touch icon.

**Structured data (JSON-LD):**
- `Organization`: name, url, logo, and `sameAs` for LinkedIn and Instagram.
- `WebSite`.
- `SoftwareApplication`: name, `applicationCategory: BusinessApplication`, `operatingSystem: Web`, and
  a description that names SAP Business One and Beas. No `offers`: no pricing.
- `FAQPage` where there's a FAQ, and `BreadcrumbList` on sub-pages.

**Files at the root:** `sitemap.xml` (`@astrojs/sitemap` with i18n), `robots.txt` and `llms.txt`.
- `robots.txt` allows everyone. That explicitly includes the search and assistant crawlers
  (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User, Bingbot,
  Googlebot) **and** the training crawlers (GPTBot, ClaudeBot, Google-Extended, Applebot-Extended).
  That's my call: for a marketing site, being learned about is the point. It ends with the sitemap
  line.
- `llms.txt` is generated at build: one line per page and language, with title, a one-line summary
  and the URL. **Expectations are low.** ChatGPT, Claude and Perplexity don't use it to choose
  citations; only coding agents read it. It's cheap, so it ships.

**What actually earns AI citations:**
- Text in the HTML.
- The crawlers allowed in.
- Being indexed by **Bing** as well as Google (ChatGPT's search leans on Bing).
- Passages that answer a buyer's literal question in their first sentence (the FAQ, and each
  section's lead).
- Plain, checkable facts: supported setups, where data lives, what the AI sees.

At launch: verify the domain in **Google Search Console and Bing Webmaster Tools** (DNS TXT) and
submit the sitemap. IndexNow pings can come later.

**Quality gates** (the build or CI fails, or the release checklist blocks):
- The build fails on a raw colour in the site's CSS (§5.2) and on a missing translation key (§8).
- **Lighthouse (mobile):** Performance ≥ 95, Accessibility 100, Best practices 100, SEO 100, on `/`
  in each language.
- **Budgets:**
  - LCP < 2.0 s on a mid-range phone over 4G.
  - CLS < 0.05. Use font-metric overrides on the fallback so the 72 swap doesn't shift.
  - INP < 200 ms.
  - First-view transfer ≤ 200 KB before consent.
  - At most two preloaded fonts (72 Regular, 72 Black).
- **Accessibility, WCAG 2.2 AA in both themes:**
  - Contrast checked; `--ai-ink` exists because raw AI purple fails on Evening.
  - Visible focus.
  - Reduced motion honoured.
  - Form labels.
  - A skip link.
  - Primary touch targets ≥ 44px.
- **Responsive:** checked at 360, 390, 768, 1024, 1440 and 1920 px wide, with no horizontal
  scrolling. The glows must not widen the page: sections clip their own overflow.
- **Without JavaScript:** every page reads fully and the form submits.
- **Previews:** checked in LinkedIn Post Inspector and Meta Sharing Debugger before the first ad.

## 13. Calls I made (the owner should check these)

1. Launch doesn't wait for the brand. The builder makes placeholder brand assets in the site's
   style: one 1200×630 share image per language, the favicon and 180px touch icon, and the logo used
   by the shell bar and `Organization.logo`. They're redone when the brand arrives.
2. English at the root, Spanish at `/es/`, Basque at `/eu/`; paths in English for every language
   (§8).
3. No theme toggle; the site follows the system's Morning/Evening (§3).
4. Product visuals as HTML, not screenshots (§5.5).
5. The demo route on the portal process; the mail is awaited, not fire-and-forget; no table (§9).
6. Training crawlers allowed in `robots.txt` (§12).
7. Share images are made by hand for now (see 1), and generated at build only once the page count
   makes that worth it.
8. Display type larger than Fiori's H1, and 16px body text (§5.3).
9. The site deploys on its own, never as part of an app release (§11.2).

Decided by the owner during the design: the audience and the one job (§1), the three languages, being
found through Google, AI assistants, LinkedIn and Meta ads, a mailed demo request, content edited in
code with no CMS, Morning/Evening Horizon with their own brand later, nothing from the auth pages,
the technology choice (§7), the approved mockup, visitor analytics, and Plausible.

## 14. Left to the builder

- The Astro project's internal layout: components, CSS split, and how the variable pruning and the
  raw-colour check are implemented (a small build script is enough).
- Exact rate-limit numbers, the mail template (plain text is fine), and the thanks/error page wording.
- Whether to proxy Plausible through Caddy.
- Font-metric overrides for the fallback font, and which 72 weights to preload.
- Icon names beyond those in the mockup.
- Small spacing and size adjustments that keep the approved look.

## 15. Content the owner provides or confirms before launch

- **Final copy in all three languages**, including a Basque review by a native speaker.
- **Legal notice data** (LSSI art. 10): company name, NIF, address, registry details, contact email.
  Also the privacy and cookie policy texts.
- **The contact address: open, and it blocks launch.** Three things need it: `DEMO_INBOX`, and the
  public contact for the error page, the footer and the legal notice (one address, or two). Whichever
  is public must actually receive mail. `confire.ai` has no MX today, so a `@confire.ai` address needs
  inbound routing first (for example Cloudflare Email Routing forwarding to the owner's inbox, plus
  its MX records in DEPLOY.md). The build reads it from config, so choosing it later changes no code.
- **Facts the draft asserts and must be checked:**
  - "Hosted in the EU".
  - Which AI it uses and what it sees.
  - Setup time.
  - Supported SAP versions and databases.
  - "Reads PDFs and drawings".
  - The before/after time figures (the "2–5 days" is a placeholder).
  - Every number in the illustrative visuals.
- LinkedIn and Instagram profile URLs (for `sameAs` and the footer). Meta Pixel and LinkedIn Partner
  IDs.
- The brand: logo and colours. It replaces the "C" placeholder, and its colours fill the brand
  contract (§5.2).
