# The auth pages, redesigned

2026-10-31. Status: built 2026-10-31. The approved look is `2026-10-31-auth-pages-mockup.html`
(beside this file): every page in its final layout, in Morning and Evening (the switch at its top).
Like the marketing site's mockup, it loads SAP's theme files, the 72 fonts, two icon sprites and the
logo from `/files/…`, which the brainstorm companion served. Opened on its own, it falls back to
system fonts and no colours. In the app, all of these are already loaded: UI5's theme and fonts,
`@ui5/webcomponents-icons`, and `apps/app/public/confire-logo.png`.

## 1. Why

The pages a person sees before they're inside an app are sign-in, sign-up, password reset,
"Where to?", workspace setup, and the portal's invitation pages. Today they're a split screen with a
dark navy panel, the Fraunces serif from Google Fonts, and teal and cyan colours they define
themselves (`packages/ui/src/auth/AuthLayout.css`). The owner finds them basic and lifeless. They're
also not Fiori: nothing on them comes from Horizon, so they look like a different product from both
the app behind them and `confire.ai` in front of them.

Most visitors arrive at **Sign in** from `confire.ai`, so the auth pages must look like the same
product. They use the same design system as the marketing site
(`2026-10-30-marketing-site-design.md`): Horizon's variables, 72 type, the dotted hero background with
its blue and purple glow, and Fiori parts drawn in plain HTML and CSS.

**Success:** someone clicks *Sign in* on `confire.ai` and feels they never left. The owner opens every
page in Morning and Evening, on a phone and a desktop. Each page looks like the mockup, and each page
still does everything it does today (§6).

## 2. Goals

1. **One frame for every auth page, in both SPAs.** It's layout "A" of the mockup, made up of:
   - the site's shell bar, holding the logo and a language switch;
   - the site's dotted hero background, with the brand glow and the AI glow;
   - one 72 Black display headline, written as a sentence ending in a full stop;
   - one Fiori card in the middle (a glass rim around a solid panel);
   - links under the card;
   - a small legal footer.
2. **The page designs in the mockup**, all eleven (§5).
3. **The logo is `apps/app/public/confire-logo.png`**, used both as the logo and as the favicon.
4. **Keep every function each page has today, and nothing more** (§6). This is a restyle and a
   restructure, not a behaviour change.

## 3. Non-goals

- Changing what any page does. That covers routes, URLs, guards, redirects, the dispatcher's rules,
  server calls, and mail. The one exception is the theme default, which the owner decided in §7.
- Carrying the language from `confire.ai` to sign-in. The owner decided against it: the auth pages
  use the browser's language, or the one picked in the app, as today.
- Supplier branding on sign-in or sign-up. Those stay Confire's (CLAUDE.md: "no supplier branding on
  sign-in"). The supplier appears only on the portal pages that are already under its path (§5,
  pages 10–11).
- The portal's **new-client form** (`$slug_.onboarding_.$invitationId`). It's a ShellBar plus the
  BP-create `ObjectPage`, an app page rather than an auth page, and it stays as it is. Only its
  "This invitation can't be used" state uses the new frame.
- A theme toggle on the auth pages, new sign-in methods, a bot check, or "remember me".
- Anything taken from today's design. The Fraunces font, the navy panel, the "cloud → agent → B1"
  motif and the `.reveal` stagger all go.

## 4. Anti-goals: a failure even if it works

- **A page that lost a function it had.** Examples: the `redirect` no longer carried to sign-up and
  social sign-in, or an invited address no longer locked on sign-up. §6 is the checklist.
- **Password managers can't fill or save.** These are the pages where that matters most.
- **A raw colour.** It breaks Evening and the coming rebrand (site spec §5.2), which overrides SAP
  variables and nothing else. The one exception is the Google and Microsoft glyphs, which must keep
  their own colours.
- **Horizontal scroll on a 360 px phone,** including with Basque text.
- **Looking like a different product from `confire.ai`.**

## 5. The pages

They're numbered as in the mockup. "Card" means the Fiori card, and "under" means the links under it.

**Staff app, `app.<DOMAIN>`** (the sign-in host):

| # | Route | Headline | Card | Under |
|---|---|---|---|---|
| 1 | `/login` | Welcome back. *(lead: Sign in to your workspace or your supplier's portal.)* | Google, Microsoft side by side · "or" · Email · Password, with *Forgot password?* at the right of its label · **Sign in** | New to Confire? *Create an account* |
| 2 | `/signup` | Create your account. *(Use your work email address.)* | Google, Microsoft · "or" · Name · Work email · Password and Repeat it side by side (stacked on a phone) · **Create account** | Already have an account? *Sign in* |
| 3 | `/signup` sent, `/forgot-password` sent | Check your inbox. | Icon tile (envelope) · the sentence saying where the link went, the address in bold · the retry note · *Back to sign in* (a normal button) | |
| 4 | `/forgot-password` | Reset your password. *(We'll email you a link to choose a new one.)* | Email · **Send link** | Remembered it? *Sign in* |
| 5 | `/reset-password?token` | Choose a new password. *(At least 8 characters.)* | New password · Repeat it, with a Negative value state "The two passwords differ" · **Change password** | |
| 5b | same, done | Password changed. | Icon tile (check, Positive) · "You were signed out everywhere…" · **Sign in** | |
| 6 | `/reset-password` dead | This link no longer works. | Icon tile (error, Negative) · "Reset links work once…" · **Send a new link** | *Back to sign in* |
| 7 | `/login` signed in, several places | Where to? *(Signed in as `<email>`.)* | A Fiori list. Each row has an avatar, a title and description, chips and a chevron. Workspace: building icon, its name, "Your workspace". Portal: the **supplier** is the title (today's `tenantName`), with its initials as the avatar; the description is today's "`<cardName>` · customer portal"; there's a role chip. Whichever place is active, workspace or portal, also gets a *Last used* chip. On a phone the chips wrap under the text. | Not you? *Sign out* |
| 8 | `/onboarding`, company | Set up your workspace. *(Create your company to get started.)* | Step indicator **1 Company → 2 SAP server** above the headline · Company name · Workspace URL as a field with the prefix `app.<DOMAIN>/`, and under it a hint plus a status chip (*Checking…* / *Available* Positive / *Taken* or *Invalid* Negative) · **Create company** | Not now? *Sign out* |
| 9 | `/onboarding`, SAP server | Connect your SAP server. *(lead: today's `SHELL_AUTH_CONNECT_SUB`)* | Step indicator with step 1 done · numbered steps: **1** download the agent (the URL in a box with *Copy*, and the SmartScreen note), **2** run it and enter this code (the code large, *New code*, valid-until or expired) · a waiting row with a pulsing AI-gradient dot, which becomes "Connected. Opening your workspace…" | Not now? *Sign out* |

**Customer portal, `portal.<DOMAIN>/<slug>/…`.** The shell bar shows the **supplier's** logo and name.
If there's no logo, it shows the supplier's initials on an avatar colour. The footer reads "Powered by
Confire" with the small logo, then *Privacy*.

| # | Route | Headline | Card | Under |
|---|---|---|---|---|
| 10 | `/$slug/accept/$id` | Join `<company>`. *(lead: who invited you, to whose portal)* | A "who" block: the company's initials avatar, company name, "on `<supplier>`'s portal", role chip · the role's help sentence · **Accept invitation** | Signed in as `<email>` · *Use another account* |
| 10b | same, loading | none | "Opening your invitation…" with a busy indicator | |
| 10c | same, unusable (also the new-client form's error) | This invitation can't be used. | Icon tile (error) · the error as a Negative strip · *Go to `<supplier>`'s portal* (seated) or "ask for a new one" | Signed in as … · *Use another account* |
| 11 | `/$slug/onboarding` | Ask for an invitation. | Icon tile (locked, AI colours) · today's body text · "Invited at another address? *Sign out*, then open the invitation again." | |

**Messages** (wrong password, unconfirmed address, `?error=`, create failed, a SAP login the agent
reports refused) use UI5's `MessageStrip` at the top of the card. These are Negative, except the agent
one, which is Critical as today.

## 6. What every page keeps (the checklist)

Read today's route files before changing them. Every behaviour below survives:

- **`/login`:**
  - `?email=` prefills the address.
  - `?error=` reads through `authErrorMessage`.
  - `EMAIL_NOT_VERIFIED` says where the fresh link went (`notVerifiedMessage`).
  - Sign-in is deliberately unconditional, and the session is refetched with `staleTime: 0`.
  - `redirect` is carried to sign-up and to the social buttons.
  - Signed in, it's the **dispatcher**: a safe `redirect` comes first, then the active place, then
    the one place. Otherwise it shows Where to?, and `?choose` forces Where to?. With no place, or a
    workspace that still needs its agent, it goes to `/onboarding`.
  - On a tenant path it moves to the sign-in host.
  - Where to? signs out, clears the query cache, and does a full page load into the chosen place.
    Rows are real links (`<a href>`), so open-in-new-tab works.
- **`/signup`:**
  - An invited address is prefilled and read-only.
  - The repeat must match before submit.
  - On success it shows *Check your inbox*. Its sign-in link keeps `redirect` and `email`.
- **`/forgot-password`:** sends the reset mail, then shows *Check your inbox* with the reset sentence.
- **`/reset-password`:** a missing token or `?error` gives the dead-link state; otherwise the form,
  then *Password changed*.
- **`/onboarding`:**
  - It redirects as today: signed out → `/login`, has a workspace → into it, needs an agent → the
    SAP step.
  - The slug follows the company name until it's edited. It's sanitised, checked against `SLUG_RE`
    and reserved names, and checked live for availability. Enter creates.
  - The SAP step issues a code on arrival and polls the agent's status every 3 s. Once connected it
    moves into the workspace. A paired agent whose SAP login is refused shows its error.
  - *Sign out* leaves the page.
  - `PairingCode` is also used by Settings → SAP agent. That use keeps today's look; only the
    onboarding step gets the new layout. *Copy* is the one addition.
- **Portal accept:**
  - It's guarded by `invitationGuard`.
  - A new-client invitation goes on to its form.
  - Accept resets `me` and lands on the portal home.
  - *Use another account* signs out and reopens the same link.
- **Portal onboarding:** the auto-join attempt in `beforeLoad` stays as it is. *Sign out* goes to
  `loginUrl()`.
- **Pending states:** a button busy during a call shows today's pending text (*Signing in…* etc.)
  and is disabled.

## 7. How it's built

### Decided by the owner

- **Layout A** of the first mockup, "centred on the hero", for every page. The other option, the form
  beside a product loop, was rejected.
- **The logo** is `confire-logo.png`, as the logo and the favicon.
- **The eleven page designs** as drawn ("looks good"). One correction from review: Where to?'s
  portal rows are titled by the supplier, as today (§5 row 7).
- **Theme follows the OS until the user picks one,** across the auth pages and both apps, as
  `confire.ai` does.
  - **The problem today:** each shell's `useAppearance` saves its default (`sap_horizon`) to
    `localStorage` on first mount, whether or not anyone chose it. Also, the auth pages never apply
    the stored theme, because `useAppearance` runs only inside `AppShell`/`PortalShell`.
  - **The change:**
    - Store a theme only when the user picks one in the user menu.
    - With none stored, use Horizon Auto (Morning or Evening by the OS).
    - Apply the stored theme at SPA start-up, so the auth pages get it too.
  - **Existing stored values:** a `sap_horizon` that was saved without being chosen can't be told
    apart from a real choice. It stays, and those users keep Morning until they pick again.
- **Language is not carried over from `confire.ai`.** The auth pages use the app's language as
  today: the browser's, or the one the user picked. Their language switch is that same remembered
  choice (call 3).

### My calls (the owner should check these)

1. **Native `<input>` and `<button>` inside a real `<form>`, styled with the site's CSS, instead of
   UI5 `Input`/`Button`.** On a page whose job is credentials, password managers and autofill matter
   most. UI5's `Input` (2.23.1, checked) has no `autocomplete` attribute, and its native input lives
   in a shadow root. Native fields take `autocomplete="email" | "current-password" | "new-password"`
   and `name`. They also submit on Enter, and are exactly the site's field style (the site's
   `components.css` has it). UI5 stays for `MessageStrip` and the busy indicator. Icons are UI5's
   (`@ui5/webcomponents-icons`), drawn as inline SVG like the site does, or as `ui5-icon`.
2. **Google and Microsoft come first,** above the email form. A work account is how a customer
   auto-joins their company's portal (`hasWorkAccount`).
3. **The shell bar has only the logo and the language switch.** There's no "Book a demo" or site
   nav, because portal customers sign in here too.
   - **On staff pages,** the logo links to the site's home in the current language.
   - **On portal pages,** the supplier's name is not a link.
   - **The language switch** offers the app's three languages (`LANGUAGES` and `useLanguage` in
     `@confire/ui/i18n.ts`), so the choice is the same one the app's user menu remembers.
4. *(Theme: decided by the owner, above.)*
5. **Footer links go to the site's legal pages,** in the current language: `/privacy/`,
   `/legal-notice/` and `/cookies/`, under `/es/` or `/eu/` when the app is in Spanish or Basque.
   - **The site's origin** is the apex: `https://<DOMAIN>`, and `http://localhost:4321` in dev.
   - **The portal footer's** *Privacy* link is Confire's `/privacy/` too. No per-supplier privacy
     URL exists, and adding one would be new behaviour.
6. **The confirmation states** (inbox, password changed, dead link, unusable, no invitation) draw an
   icon in a soft tile, which is Fiori's illustrated message reduced to an icon. They don't use UI5's
   `IllustratedMessage` artwork, which clashes with the site's look.
7. **Copy, new or reworded:**
   - every headline is a sentence with a full stop;
   - the sign-in lead;
   - the URL hint "Your team's permanent address.";
   - the step labels *Company* and *SAP server*;
   - *Last used*;
   - *Copy*.

   Each goes into English, Spanish and Basque bundles. Spanish and Basque are drafts for the owner.
8. **Life, kept quiet:**
   - the glows;
   - the waiting pulse on the SAP step (purple, because the agent is doing the work).

   No entrance animation. A rise-in was built first and taken out (owner: "the transition from
   marketing to login/signup … can be felt that is a hard redirect"). The page has to arrive whole,
   in one frame, as if confire.ai had only moved on. Three load-time flashes went with it: a white
   page, Morning before Evening, and text hidden while the 72 fonts load. CLAUDE.md "Tenancy is the
   path" records the fixes.

   `prefers-reduced-motion: reduce` shows everything still.
9. **The marketing site's mark becomes the logo too**: the shell bar's "C" square becomes the image,
   and `public/favicon.svg` is replaced by the PNG. The OG images, `logo.png` and
   `apple-touch-icon.png` were generated from the old mark. They need a larger source than 128 px
   and are left for later (§9).

### Constraints

- **Colours:** every colour is a Horizon variable or a `color-mix()` of them (the site's rule). The
  SPAs already have every `--sap*` variable at runtime from UI5's theme, so nothing is copied from the
  site's generated `sap.css`. The derived tokens (`--glow-brand`, `--glow-ai`, `--dot`, `--hairline`,
  `--glass`, `--ai-ink`, `--ai-wash`, `--brand-wash`) are ported from `apps/site/src/styles/tokens.css`.
- **Fonts:** UI5 already loads 72, including Black (weight 900), from its CDN
  (`@ui5/webcomponents-base`'s `FontFace.css`). Delete the Fraunces `<link>` from both
  `index.html` files.
- **Themes:** it works in every Horizon theme the user menu offers. It must look right in Morning
  and Evening, and stay legible in High Contrast.
- **Layout:** Fiori breakpoints. On a phone the card goes full width and the headline shrinks, with
  no horizontal scroll at 360 px. The page's one `<h1>` is the display headline.
- **Accessibility:** every field has a real `<label>`, the focus ring is the Horizon focus
  variables, and the glows are `aria-hidden`.
- **Where the frame lives:** one frame shared by both SPAs, in `packages/ui/src/auth/` (it replaces
  `AuthLayout`). Each SPA passes its brand: Confire's in the app, the supplier's in the portal, as
  today.
- **Gates:** typecheck per project (`packages/ui`, `apps/app`, `apps/portal`) and both SPA builds
  (CLAUDE.md "Commands").

## 8. Left to the builder

- The component split, file names, CSS organisation and class names.
- How to follow the OS theme with UI5 when nothing is stored (`appearance.ts` already lists Horizon
  Auto).
- How to derive the site's origin. It's probably one more helper in `@confire/ui/host.ts`, read off
  the location like `origins()`.
- Whether to add a raw-colour check for the new CSS. The site's `rawColours` in
  `apps/site/scripts/prebuild.ts` is the rule.
- i18n key names. Reuse today's keys where the text stands.
- How to verify. There's no behaviour change, so no new server tests. Walk every page and state from
  §5 in Morning and Evening, at 360 px and at desktop width, with a headless browser (dev tenants
  have verified users).

## 9. Later

- **The privacy page doesn't cover app users yet.** `apps/site/src/content/legal/*/privacy.md` says
  it's for "this website's visitors and those who request a demo". Now the app's footers link to it,
  so it needs a section on staff accounts and on a supplier's portal customers. That's a content task
  for the owner, not code.
- OG images, `logo.png` and `apple-touch-icon.png` for the site, from a large or vector logo.
- A Confire brand palette replacing SAP blue. It's one file of variable overrides, per the site
  spec.
