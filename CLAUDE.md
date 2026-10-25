# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Confire is a multi-tenant SaaS quoting platform for SME manufacturers running on-prem SAP Business One.
`AGENTS.md` describes what the product does in plain language; this file is the technical picture.

## Commands

Everything runs on **Bun** (no npm — see `package.json` workspaces).

```bash
docker compose up -d db                 # Postgres 17 on :5432 (dev runs server/app with bun)
bun install
bun run dev                             # sign in at http://localhost:5173/login; staff app
                                        # localhost:5173/<slug>/ (server :3000), portal
                                        # localhost:5180/<slug>/ (server :3001), agent :4000
                                        # (Go: `go run . run` in apps/agent — Go must be installed)
bun run dev:pair                        # pair a real SAP server's agent with dev: a public quick
                                        # tunnel to :3000; on that server run `confire-agent.exe
                                        # setup --server https://<printed>.trycloudflare.com`, then
                                        # stop it. Pairing is the only call the agent makes to us:
                                        # after it, dev reaches the agent on its <label>.confire.app
                                        # (CF_* in .env), so later dev runs need no tunnel
bun run db:push                         # drizzle-kit push: dev's schema sync, never production's
bun run db:generate                     # a schema change's migration SQL — commit it with the change
bun run auth:generate                   # regenerate schema/auth.ts after a Better Auth config change
```

The Better Auth CLI is the `auth` package (`@better-auth/cli` stopped at 1.4). Its version is pinned
in `apps/server/package.json` and moves together with `better-auth`.

There is no lint step. Type-checking is the gate, and it is **per project** — there is no root
tsconfig that covers everything, so a change can typecheck in one package and break another:

```bash
bunx tsc -p apps/server/tsconfig.json --noEmit
# projects: packages/{b1,config-engine,db,ui}, apps/{server,app,portal}
bun --cwd apps/app build                # also regenerates routeTree.gen.ts (gitignored)
bun --cwd apps/portal build             # same, for the portal's route tree
```

Note `apps/server/tsconfig.json` also includes `../../scripts`, so the seed/migration/e2e scripts
are checked there rather than in a project of their own. The agent is Go: in `apps/agent`,
`go test ./...` and `GOOS=windows go vet ./...` (the Windows half only compiles there).

## The processes

```
Browser: apps/app (staff)               Browser: apps/portal (the manufacturer's customers)
   │ oRPC over /rpc, same-origin            │ (dev: Vite proxy; prod: each server serves its SPA)
   ▼                                        ▼
Confire server (apps/server/src/index.ts)   Portal server (apps/server/src/portal/index.ts)
   │                        └── Postgres ──┘
   │ HTTPS to the tenant's agentUrl (prod: <label>.confire.app, Cloudflare Access + Tunnel)
   ▼
confire-agent (Go, a Windows service on the customer's SAP server) ── SAP B1 Service Layer /b1s/v2
```

The customer portal is a second process from the same image (compose service `portal`, CMD
`start:portal`) so external traffic never shares an event loop with staff. Both are `serve.ts`:
Better Auth on `/api/auth`, oRPC on `/rpc` with the 2 MB body cap, the SPA on the rest. The same
router is also plain HTTP under **`/api/openapi`** (`OpenAPIHandler`, router-derived paths:
`configs.calculate` is `POST /api/openapi/configs/calculate`), with its spec at `/api/openapi/spec.json`
and a Scalar page at `/api/openapi` — both for signed-in users only, auth unchanged (cookie +
`x-tenant`); it is for people, not a public API (no keys). oRPC is **v2 beta, pinned exactly**
(every `@orpc/*` on one `2.0.0-beta.N`, bumped together): v2 has no `ORPCError.status` (`errorStatus`
in `serve.ts` maps a code), and pretrained oRPC knowledge is v1 — the `orpc*` skills carry v2. The design
record is `docs/superpowers/specs/2026-10-07-portal-redesign.md`; P0–P6 are built (see its §15).

The agent (`apps/agent`, Go; `docs/superpowers/specs/2026-10-21-agent-autosetup-design.md`) is one
self-installing Windows exe: a wizard asks the SAP questions on the box (each tested with a real
login) and a one-time **pairing code** last; it then runs as a Windows service with `cloudflared` as
its child. SAP credentials live in its `agent.json` and never reach the cloud. It is **thin**: it holds
the SAP sessions and forwards an **allowlist** (`allow.go`, the security boundary, tested) of
`{ method, path }` requests on `/{b1|beas}/request`, plus `/print` and `/health`; every path is still
built by `packages/b1/src/query.ts`, now on the cloud side, so most changes ship with Confire and need
no agent update. **Pairing** (`agent-pairing.ts`): `sap.pairingCode` stores a code in Better Auth's
`verification` table; the agent redeems it on the plain route `POST /api/agent/pair` for its secret and
tunnel token, and `cloudflare.ts` creates the tunnel, its route and the DNS name — with `CF_API_TOKEN`
unset (dev) the answer is `http://localhost:<port>` instead. The Access service token is one for all
tenants, so it is server env. `sapConnection.agentUrl` is that localhost URL in dev and a tunnel
hostname in production — **that difference is a database row, not a branch in the code**, which is why
nothing here is conditional on "dev vs prod". The deployment itself is one setting, `DOMAIN` (below);
the root `.env` needs only `DATABASE_URL` and `BETTER_AUTH_SECRET` in dev.

**One SAP company at a time, switched on the SAP server only** (wizard or `agent.json`). Every call
carries `X-Confire-Company` (`agentPost`); an agent on another company answers 409 `COMPANY_CHANGED`
before it touches SAP, and `adoptCompany` (`b1.ts`) takes the agent's company once and clears the old
one's caches (local currency, `entity_meta`, masterdata rows). A posted quotation remembers its company
(`config_project.b1_company`): only there is it patched, linked or shown on the timeline. Decide a
company-bound step off `Connector.companyDb` — the company the call itself carries — never a second
read. Portal clients are deliberately not fenced by company (spec §6.2).

## Tenancy is the path

Two fixed hosts, no tenant subdomains (`docs/superpowers/specs/2026-10-19-path-tenancy-design.md`): the
staff app on `app.<DOMAIN>/<slug>/…`, the portal on `portal.<DOMAIN>/<slug>/…`. In each SPA the slug is
the **`$slug` route param** (`routes/$slug.tsx`: the tenant's guard and the app's shell, in both SPAs — the portal's
pages before a seat are `$slug_.*`, same URLs but not nested, guarded by `lib/guards.ts`; the bare
origin is `routes/index.tsx`, the dispatcher's). A link never names or changes it: typed navigation is
`useNavigate({ from: "/$slug" })` + `to: "/$slug/…"`, which carries the param over, and the shells'
declared routes (`/b1/Items`) go through `useEntityNav` (`@confire/ui/EntityLink.tsx`), which puts them
under `/$slug`. Moving to another tenant is always a full page load — the query cache never holds two.
The staff app's admin-only pages (`/b1/*`) sit under the pathless `_admin` layout; Settings does not — its
Notifications tab is every member's (`?tab=notifications`), the other tabs are admin-only in the page.
The oRPC link sends the slug as **`x-tenant`** on every call; the plain file routes carry it in their
path (`/files/<slug>/…`), because a download is a link. `tenant.ts` is the only place a slug is read
off a request (`tenantSlug`, with the reserved names: the staff SPA's top-level pages and the server's
routes). `orpc/base.ts` joins it against `member` — **the membership join is the tenant boundary**,
so a forged `x-tenant` can only ever select an org the user already belongs to. Three procedure
builders compose that check:

| Builder | Who |
|---|---|
| `sessionProcedure` | signed in; `me` resolves membership itself |
| `userProcedure` | staff of this workspace: any `member` role but `external` |
| `adminProcedure` | admin/owner — model builder, settings |

**One sign-in for both:** one Better Auth instance (`auth.ts`), one `session` table, one cookie. The
sign-in host is the staff app's origin (`baseURL`); the cookie is on `<DOMAIN>` itself so it reaches
both hosts, and host-only on `localhost` in dev (cookies ignore ports). Both processes mount it on
`/api/auth`. A session says who you are, never where you may go: that is the membership join here and
the seat join on the portal. The session **remembers** where it last worked: each app's `me` writes
`session.activeOrganizationId` (`rememberActiveOrganization`) — the path decides, the session only
remembers. `/login` is also the **dispatcher** (`sap.lobby` lists the workspace and every portal seat,
with server-built URLs and `active` marked): signed in, it follows a safe `redirect`, else goes to the
active place, else the one place, else renders "Where to?" (`?choose` asks for it outright: the
portal's *Switch supplier*); no place at all is workspace setup. A portal stays invite-only because a
portal-originated sign-in carries `redirect` back to the portal, whose own guard shows the invite-only
page — sign-in itself cannot know who is "a customer".

**A customer is a member of the supplier's organization** whose role is its role in its company:
**`portal_owner`/`portal_buyer`/`portal_viewer`** (`EXTERNAL_ROLES`, access-control roles with no
permissions; prefixed because Better Auth compares role names exactly, so `portal_owner` is never its
`owner`). The API and UI say `owner`/`buyer`/`viewer` (`PortalRole`); `externalRole()` and
`portalRoleOf()` (`@confire/db`) convert at the DB. One extra member field, `cardCode`, is its company:
a `portal_company` is (tenant, CardCode) and has no id of its own, so a CardCode is never matched
without the tenant. One member row
per (organization, user) is "one company per user per tenant" and makes staff and customer of one
tenant exclusive. Every staff query filters `role not in EXTERNAL_ROLES`; `organizationLimit` counts staff rows
only, so a customer may still found their own workspace. Better Auth's organization endpoints treat
all members as peers (`list-members` would show a customer every other customer), so `auth.ts`
disables every one but `create` and `check-slug` (`disabledPaths`, computed from the plugin).
Builders (`portal/orpc/base.ts`); every tenant-scoped one refuses the supplier's own staff:

| Builder | Who |
|---|---|
| `portalAuthedProcedure` | signed in; no tenant (`lobby`); `me` resolves the rest itself |
| `portalSessionProcedure` | + the request's tenant, maybe no seat yet |
| `portalMemberProcedure` | + a seat: the `external` member row ⋈ its `portal_company` |
| `portalBuyerProcedure` / `portalOwnerProcedure` | seat role `buyer`/`owner` / `owner` |

**`portal/members.ts` is the only writer** of external member rows (`addPortalMember`, `changeMember`), `portal_company_domain`
(`claimDomain`) and portal invitations (`sendInvitation`, `cancelInvitations`), and both processes
import it. The internal router (`orpc/routers/portal.ts`: `portalInvitations`, `portalCompanies`)
and the portal's (`onboarding`, `company`) therefore enforce one rule set. Invitations are Better Auth's own `invitation` rows with a `portal_*` role plus `cardCode` (null = a new
client) and `registerDomain`; Better Auth's accept stays off (it inserts the member bare,
before a new client has a company, and never checks an existing membership), so accept and onboarding
submit end in `addPortalMember` instead, with the organization and the company both known. The rules:
- One open invitation per email: `sendInvitation` locks the organization row and checks (the generated schema cannot carry the partial unique index). An expired row stays `pending` and blocks nothing.
- A second way into the same company never lowers a role.
- No change may leave a company that had an owner with none.
- Free-mail domains are never registered or auto-joined.
- Staff and customer of one tenant are mutually exclusive: `addPortalMember` refuses a staff row. It
  locks the user row first — the generated Better Auth schema cannot carry a unique
  (organizationId, userId) index, so the lock is what stops two concurrent joins both inserting.

Ways in are an invitation (`/<slug>/accept/<id>`, existing-BP from the BP Object Page's *Invite to portal*)
or auto-join (`onboarding.join`, a verified address on a domain registered to a company).
Signed out, an invitation link goes to sign-up when the invited address has no account yet, else
sign-in, the address filled in (`invitationGuard`): it asks `onboarding.invitee`, the portal's one
procedure without a session — the link's random id is the credential.
`bun run seed:portal` gives a dev tenant a company and an owner login.

**New-client onboarding** (spec §5.3–5.4): *Invite new client* on the BP List Report sends an invitation
with `cardCode` null; its link goes on to `/onboarding/<id>`, the BP-create `ObjectPage` unchanged over
`apps/portal/src/features/onboarding.ts`. `portal/onboarding-form.ts` is the one form rule (pure,
tested): the denylist, what the settings picker offers, the form's fields (addresses and contact as flat
`BillTo.*`/`ShipTo.*`/`Contact.*` keys), validation and the lead payload. `onboarding.formSchema` returns
it as `EntityConstraints` plus a **seed**, and `submit` validates the form laid over that same seed
(ObjectPage's create diff never sends a value equal to the seed). Submit is check-then-create on
`U_CF_Key` over OCRD, keyed per invitation, then one transaction: company (`cLid`), invitation accepted,
the invitee its owner. Settings → Portal holds the extras and the lead series (`SeriesService`, empty =
B1's default lead series).

**Portal projects** (spec §7): a published model (`config_model.portal`, set by `models.publish`, not
by `save` — publishing must not bump `updatedAt`) becomes a client's project, `config_project` with
`portalCardCode` set. **The engine runs on the server**: `portal/orpc/projects.ts` returns the
projection in `portal/projection.ts` (pure, tested) and never a `ModelDef`, lookups or a candidate —
that module is the fence outward (`toPortalForm` over the shared form state), and `config-patch.ts`'
external rules are what a client may write.
**`project-lifecycle.ts` is the only writer of `status` and `config_project_event`**, imported by
both processes: `transition()` locks the row and writes the status and its events in one
transaction (it opens its own, then notifies after commit); `assertWritable(…, actor)` +
`writableBy(side)` say who may edit in which status; an internal read never sees a client's draft
(`internalVisible`). **Files** (D14) are `project_file` bytea rows behind plain Hono routes,
`files.ts`, mounted by both processes past the 2 MB RPC cap: `addFile` writes the row and its `file`
event together, a download is always an attachment, and the one row served without a session is the
tenant's branding logo (`projectId` null), which mail links to absolutely. Staff work requests in Portal →
Requests (`orpc/routers/requests.ts`) and on the existing process page. The timeline is
`project-timeline.ts`: events from Postgres, SAP document chains as a separate live read.

**Portal documents** (spec §13.1): a client's own quotations, orders, deliveries and invoices.
`portal/doc-fields.ts` is the one field rule — `ALWAYS` (DocNum, status, total…), `NEVER` (CardCode),
a cost/margin/purchase-price denylist and code defaults — and `portalSchema` applies it **on read**,
so a stale setting cannot expose a field. `portal/orpc/docs.ts` fences every read: `rows` passes
`CardCode eq '<company>'` as `readRows`' `extraFilter` and seals its cursor to `portal:<cardCode>`;
`one`, `print` and `project` read the document's CardCode before returning anything. `docs.project`
walks back through the lines' `BaseType`/`BaseEntry` to the quotation a project quoted. Admins pick
fields in Settings → Portal (`portalSettings`, one jsonb `portal_settings` document; P5 writes
`docFields`). The portal plugs `docs.*` into `UiSource`, so the shells run unchanged. Print is Preview
only, in both apps (`@confire/ui/PrintActions.tsx`).

There is no bot check and no supplier branding on sign-in: account mail is always Confire's. Host
rules for both SPAs (the path's slug, the two origins, `safeRedirect` — an absolute URL on one of the
two origins) are `@confire/ui/host.ts`. The SPAs carry no build setting: each reads its origins off
its own location (`app.<domain>` / `portal.<domain>`, any other host = dev's `:5173` / `:5180`), so
one image serves any domain.

**`DOMAIN` is the whole deployment** (`tenant.ts`): `DOMAIN=confire.ai` puts the staff app and sign-in
on `https://app.confire.ai`, the portal on `https://portal.confire.ai`, the cookie on `confire.ai` and
Confire's mail on `mail.confire.ai`; the apex only redirects to sign-in. Unset is dev: `localhost:5173`
and `localhost:5180`. **Every `*.confire.ai` host receives the session cookie: never point a name
under it at a service this stack does not control** (a subdomain takeover would collect sessions).
There is no exception: customer agents live on a separate registrable domain (`AGENT_DOMAIN`,
`confire.app`) behind one wildcard Access *Service Auth* application, so the cookie can never reach a
customer's machine — and nothing that sets a cookie is ever served under `confire.app`. The production runbook (first deploy, shipping a change, migrations, backup and restore, agents) is `DEPLOY.md`;
`deploy/update.sh` ships a version and the compose `backup` service dumps Postgres to R2 nightly.
Caddy has two fixed sites plus the apex redirect, certificates from Let's Encrypt over the HTTP
challenge (Caddy's automatic HTTPS) — no wildcard, no DNS API. There is no local full stack: dev is
`bun run dev` on localhost, and compose has no `DOMAIN` default (unset = localhost URLs, which no
deployment serves).

## Mail

`apps/server/src/mail/`: `sendMail` is the seam — Resend when `RESEND_API_KEY` is set, otherwise the
console (the server log prints each mail, links included; tests read `devOutbox`). One sending
domain, `mail.<DOMAIN>` (`mailDomain`, Resend eu-west-1): Confire's mail from `notify@`, a tenant's
client mail from `<slug>@` (`Brand.sender`, set by `tenantBrand` — which is why `tenant.ts` reserves
the mail names as slugs), the display name quoted by `formatFrom`. Dev with a key also sets
`MAIL_DOMAIN=mail.confire.ai`: `mail.localhost` is unverifiable, so Resend refuses every send with a
403 the UI never shows. **Client mail is in its company's SAP language** (`mailLang`, `layout.tsx`):
`portal_company.languageCode` copies `BusinessPartners.LanguageCode` (→ `UserLanguages.Code`; 23/25
Spanish, anything else English) on an invite, an onboarding submit and a BP edit in Confire. A
new-client invitation has no BP yet, so it carries the sender's app language (`invitation.languageCode`),
which its lead gets in SAP. Staff and account mail stay English. Templates are React Email
components (`react-email`, pinned: 6.11.3 requires a `@react-email/render` that was never
published), one typed props object each, drawn in `layout.tsx`'s frame with a `Brand`. Sends are
fire-and-forget and never throw — a mail is never on a request's critical path.

**Notifications are a bell and a mail, each switched per event by every user**
(`docs/superpowers/specs/2026-10-22-notifications-design.md`; no admin decides for anyone).
`notifications.ts` holds the catalog (`NOTIFICATION_TYPES`: id, audience `staff`/`client`, group) and
is the only writer of `notification` (bell rows carrying their own `params` and tenant-relative
`path`, never a key to the event) and `notification_optout` (everything is on: a row is one
switch-off, so a new type needs no backfill). `deliver()` drops each person's switched-off channels,
then inserts the bell rows and sends the mails, each independent of the other. **Who is eligible is
`notify.ts`**, the project-event producer, fired after commit by `project-lifecycle.ts` (a
transition, comment, file, or `assign` — staff's Reassign) and by onboarding submit: the client side
is the project's creator while still seated at its company; the staff side is the assignee while
still on staff, else every staff member (each kept or not by their own switch), so a request is never
silent; never the actor; an internal event tells nobody, `assigned` aside. Client mail wears the
tenant's branding and its slug as the sender; staff mail is Confire's, from `notify@`. Recipients are
read at send time; a mail failure lands on the event's `mailError`. Both routers carry the same six
`notifications.*` procedures over (the path's tenant, the session's user), and each SPA polls
`unreadCount` every 30 s for its ShellBar bell (`@confire/ui/notifications`). **Tests never send:**
`bunfig.toml` preloads `scripts/test-preload.ts`, which drops `RESEND_API_KEY` (and `CF_API_TOKEN`, or
the pairing tests create real tunnels); tests read
`devOutbox` and await `notificationsSettled()`.

Email + password sign-in requires a verified address (`requireEmailVerification`): sign-up returns
no session, and an unverified sign-in is refused with `EMAIL_NOT_VERIFIED` after mailing a fresh
link (`sendOnSignIn`). The test harness verifies its users directly before signing them in.

## The assistant

`apps/server/src/assistant/` and `apps/app/src/assistant/` (`docs/superpowers/specs/2026-10-24-ai-assistant-design.md`;
phases 1–2 built, MCP is phase 3). Claude through TanStack AI (`@tanstack/ai` + `-anthropic` on the
server, `@tanstack/ai-react` in the app); `model.ts` is the one provider seam (`ASSISTANT_MODEL`,
default `claude-sonnet-5-5`; tests swap in `fakeText` with `useTestAdapter`, and the preload drops
`ANTHROPIC_API_KEY`). Staff only: the portal has no assistant.

- **Two fixed structured calls, then the chat.** A drop in the panel runs `assistant.intake`
  (`intake.ts`: model, customer, name over the models' descriptions — nothing is created), then
  `assistant.start` (no model call: `createProject(…, "assistant")`, the thread linked, the drop copied
  to `project_file`), then `assistant.extract` (`extract.ts`). Typed messages go to the chat,
  `POST /api/assistant` (`route.ts`, AG-UI over SSE, staff process only). Intake and extract write
  their results into the thread as tool-call/result pairs, so the chat reads one history; their tools
  (`read_request`, `extract_values`) are in every tool set because a request naming an undefined tool
  is refused.
- **Extraction fills empty fields only.** `modelBlock` (the cache breakpoint: stable per model version,
  it lists options whether a rule rules them out or not) and `extractionSchema` (generated per model:
  objects and `anyOf` only — Claude's structured output takes `additionalProperties: false`, no `oneOf`,
  no bounds) feed one call; `planApply` (pure) turns the answer into one patch plus questions — a
  filled field that differs, an option the list lacks or a rule rules out, a number out of range,
  anything unsure. The view is read again after the model answers, so what the user typed meanwhile
  stands. A locked configuration, a switched-off workspace and an over-cap drop are refused before
  any model call (unbilled).
- **Provenance is on the configuration**: `config_project.sources` (key → `{ value, source }`), written
  only by `configs.calculate`'s optional `sources` in the same UPDATE as the patch; a write of a key
  without a source drops it (a human edit, the portal's included). The page marks a field ✦ while its
  entry still equals `value`, 💬 while a question is open (`marks.ts`). The chat's `configs_calculate`
  tool requires a source per written value (`missingSources`): no value from nowhere.
- **Tools are the procedures** (`tools.ts`), run with `call(procedure, input, { context: { headers } })`
  under the chat request's own headers — the builders are the permission; the page registry
  (`pages.ts`, route id → tools + prompt section) is a hint. Lists are capped at 20 rows (`LIST_CAP`,
  Joule's list card). No tool posts to SAP: `propose_quotation` is `quoteDraft`, posting stays the
  quote page's.
- **Threads** (`threads.ts`) are server-owned and append-only (Sonnet 5.5 refuses edited history): the
  route takes only the last user message's text from the client. One run per thread under a lease
  (`takeLease`/`withThread`, `THREAD_BUSY`); one thread per (user, configuration) plus general ones.
  Stored file parts keep a reference (`metadata.file`), never bytes; `hydrate` refills them. File refs
  are fenced by tenant and by their own project or thread. Only PDF, PNG and JPEG, by their bytes.
- **Metered and capped**: `usage.ts` writes one `ai_usage` row per model call (`meter` middleware, cost
  from `PRICES`) and `assertAssistant` refuses when the workspace's switch (`assistant_settings`) is off
  (`ASSISTANT_OFF`, an admin's fix), the server has no `ANTHROPIC_API_KEY` (`ASSISTANT_UNAVAILABLE`, the
  operator's fix — the panel and Settings say which), or this month's cost reached
  `ASSISTANT_MONTHLY_LIMIT_USD` (default 25). `rateLimit` is 20 calls a
  minute per user. Env read with `||`, not `??`: compose passes an unset variable as `""`.
- **The panel** (`AssistantPanel.tsx`) is shell state (`AssistantProvider` around `AppShell`), floating
  over the page's right edge. **The tool's name picks the card** (`cards/registry.tsx`), never the
  model, and a card renders the tool's output — its figures are the server's; a card's actions
  navigate, scroll the page to a field, or call a procedure directly (the question chips, Pick), never
  the model. Colours come only from the theme's `--sapAssistant_*` parameters (the panel scopes the
  emphasized-button parameters to them). `scripts/assistant-eval.ts` is the hand-run eval (it spends
  money and says so first).

## `packages/config-engine` — the calculation core

Pure, dependency-free (zod only). **The server is the one source of every figure**
(`docs/superpowers/specs/2026-10-24-server-config-view-design.md`): both process pages send what the
user changed and draw the view they get back. The engine runs in the browser only in the model
builder's preview of an unsaved model, which nothing stores or quotes. `formState` turns a
propagation into the plain-JSON form both pages draw (and the preview builds the same way);
`money.ts`' `pairMoney` prices one (candidate, batch) pair — outputs, items split, a typed price wins
— for both the page's cost breakdown (`costBreakdown`) and the quotation's lines.

A `ModelDef` (one jsonb document) → `propagate` (iterate defaults/computed/visibility to a fixed
point, eliminate impossible options) → `enumerate` (DFS over open parameters, capped at 200
candidates) → `computeOutputs` (BOM, routing, cost, price). `dsl.ts` is a small hand-written
expression language; `check.ts` validates a whole model and is the gate on save, so a model that
saves cannot produce a parse/unknown-ref error at runtime.

`ResolvedLookups` is the seam: the engine never sees where options came from — manual lists and
tenant `config_masterdata` rows (kind `table` = values maintained in Confire, kind `query` = rows
cached from a B1/Beas read) are all resolved to the same shape by `apps/server/src/lookups.ts`
before the engine runs. **A model holds no table definitions**: it names masterdata, and
`referencedTables` decides which of them a resolve actually loads.

`ResolvedLookups.prices` is the same seam for **BOM material cost**. A BOM line carries no price:
it names an item, and `pricing.priceList` (a B1 `PriceListNo`) says which price, while
`pricing.itemTable` names the masterdata query whose cached rows hold it — both mandatory once a
model has a BOM, `checkModel` refuses it otherwise. `bomItemCodes` decides which codes to look up:
the string literals in each `itemCode` expression (the builder's value help writes one), plus the
resolved domain of a bare identifier, because a parameter holding the code is the other shipped
shape. It is also what keeps the price read small. An item with no line for
the price list costs 0 and its BOM line is flagged `unpriced`; the process page names each one as a
warning, so one missing price never stops a calculation (or offline work). The item query declares
**no columns** on purpose: `columns` becomes `$select`, `ItemPrices` is a complex collection B1 rejects
selecting, so the read asks for whole rows and the cache stores them raw.

**Nothing is snapshotted.** One configuration is one row: `config_project` carries its own
`entries` + `candidates` + `selection`, and a recalculate overwrites them in place. Model and
lookups are resolved on every read (`liveEngine` in `config-project.ts` — the engine's server half,
out of the router so the portal process can import it without the internal auth), so a quoted
configuration is re-priced against what the cache says now rather than what it said then —
`quotedValue`/`quotedCost` are the only frozen numbers, captured when the quotation is posted. (A portal
submit freezes the client's inputs and indicative prices — on its append-only event row, not the
project.) A stored calculation is **stale** once the model or a masterdata row it reads
(`syncTables`: synced or edited) is newer than `calculatedAt`, and every read that answers a view
refreshes a stale one first while its side may write the project (`liveProject`) — a locked project
shows its stored calculation as it is.

**Inputs and candidates move in one statement.** `candidates` is emptied in the same `UPDATE` that
writes `entries`/`batches`/`tables`, so a reader sees either the old inputs with their candidates or
the new inputs with none — never a mismatched pair. That is why there is no `calculated` status:
`calculatedAt !== null` is the whole freshness signal. Who may write a project's inputs is
`assertWritable` (`project-lifecycle.ts`): an internal configuration until it is quoted, a client's
request only in the status that is that side's (§7). An edit is a **patch** (`config-patch.ts`:
`set`/`unset`/`batches`/whole `tables`), validated against the model with one refusal naming every
problem, then **merged in SQL** (`entries || set - unset`), so two writers of different fields never
overwrite each other. The calculation's own write touches only candidates/selection/`calculatedAt`,
and only if `updated_at` is still what it read — a patch landing meanwhile wins. It never enumerates
while the view's `missing` (name, customer, batches, required parameters, the items grid) is
non-empty or a rule is broken, and a calculation that cannot complete is state (`calculation:
failed`), never a thrown error, and is not stored.

**One edit is one call.** `configs.calculate` writes the patch (name and customer too) and answers
the view (`config-view.ts`: form state, `missing`, candidates' prices, per-quantity costs, coded
`issues` — plain JSON, no raw engine output); `get`/`update` (the model switch, nothing else) add the
model, `select` answers the same. The page commits on change, never per keystroke, with no timer:
`usePatchQueue` (`@confire/ui/configurator/patch.ts`) keeps one call in flight, merges commits
meanwhile, puts picks behind edits, and the page draws the pending patch over the last answer
(`useConfigProcess.ts`). A 4xx drops the pending patch and refetches; a failure to reach the server
keeps it for Retry. The portal's `projects.calculate` takes the same patch.

## `packages/b1` — the SAP connector

Ported from the vendored `b1-mcp-server/` (MIT, SAP's sample). The MCP *protocol* is deliberately
not in the data path — its write layer is elicitation-gated, has no ETag handling anywhere, and
never parses `NavigationProperty`. The *services underneath* it are what got ported.

- `query.ts` is the **only** module that builds a Service Layer URL. Everything else passes data.
- `B1Transport` is the seam: `DirectTransport` is its one implementation, named methods over a
  `B1Requester` — in production the tenant's agent (`remote.ts` `agentRequester`, one `agentPost`
  per call, which adds the bearer, the Access headers, the company and the timeout). **Call sites
  never see a URL.**
- There is deliberately **no `readAll`**. `readPages(t, set, q, { maxPages })` takes a *required*
  cap so an unbounded fetch can never hide behind an innocent-looking line.
- `readNext` is the one method passing a B1-supplied link on; the agent resolves every path under
  the service's base and refuses one outside it.
- `action(set, key, name)` is a bound document action (`Quotations(5)/Close`); the agent allowlists
  the names again on its side. `updateEntity(…, { replaceCollections })` sends
  `B1S-ReplaceCollectionsOnPatch` so a PATCHed `DocumentLines` replaces the stored lines.
- `metadata.ts` parses EDMX with `fast-xml-parser` into plain JSON (SAP's parser builds `Map`s,
  which neither cache in jsonb nor cross the wire) and adds `ReferentialConstraint` parsing —
  that is what yields `CardCode → BusinessPartners` and makes the entity UI possible.

Deliberate fixes on port, all load-bearing: `buildKeyValue` (escapes quotes, handles composite
keys); `B1Error{status, code}` instead of `Error(string)`. The session's own fixes moved into the Go
agent's `session.go` with it: every `Set-Cookie` kept whole by a cookie jar (splitting on `,` shreds
`Expires=Wed, 09 Jun …` and loses `ROUTEID`, which a load-balanced Service Layer requires), one
in-flight login (N cold requests otherwise burn N B1 licence slots, tested), a re-login once on 401,
and self-signed certificates accepted on all three SAP services.

Beas is not a second package: it is the same session on the agent with a different `basePath`/`auth`
and the route `/beas/request`. Confire always builds its transport; an agent without Beas answers
503, as `/print` does without printing.

## Live queries are data, not paths

`config_masterdata.query` is `{ entitySet, filter?, orderby? }` plus the display-only `labels`/
`hidden` and the `syncMinutes` staleness setting. `$select` is **derived from `columns`** and never
stored, so the two cannot disagree. Value-help paging uses a `$skip` offset — a cursor that can
express nothing but paging.

`apps/server/src/b1.ts` is where a tenant becomes transports: `tenantConnector` → `runnerFor`
(the `QueryRunner` seam, which only the **sync** and the editor's live preview still hold) and
`toOrpcError` (B1 status/code → `ORPCError`, a lookup rather than a regex over a message;
`COMPANY_CHANGED` and the agent's `AGENT_REFUSED` have cases of their own).
`runnerFor` returns one page per call and nothing else — the sync walks a table by following
`nextSkip`, so no multi-page branch can hide an unbounded read.

`doc-chain.ts` uses `$crossjoin`, not `$expand`: B1's `$filter` has no lambda operators, and the
file records the three verified 400s that prove it. The `DocEntry` equality **is** the join.

## The masterdata cache — the runtime never touches SAP

A `query` masterdata's **values** live in `config_masterdata_row`, refilled wholesale by
`masterdata-sync.ts`. `resolveLookups` reads Postgres and nothing else, which is the point: with
the agent switched off the configurator still renders every section, parameter, BOM and routing
line with its cached options, and a stale cache is a page message instead of a failed request.

- **The sync streams.** It walks the single-page cursor and inserts each page, so a table with no
  declared row limit still costs O(page) memory. `packages/b1`'s `readPages` buffers everything and
  is deliberately not used here. Delete + refill share one transaction: a walk that dies partway
  leaves the last good sync in place rather than a table truncated where it stopped.
- **`seq` is the read's order**, and the composite primary key — that is what replays the query's
  own `orderby` when the value help pages it back out.
- **Rows are stored raw**, not `Val`-projected: a price list line lives inside the nested
  `ItemPrices` collection, which no flat column list can name. Projection happens at read time.
- **Freshness is a TTL checked on read**, not a schedule — there is no job runner in this repo, and
  `ensureFresh` fires off the request path and never throws, so a cold cache serves empty and fills
  in behind rather than hanging a page load. Failures land in `config_masterdata.syncError`.
- `syncTables(model)` = `referencedTables` ∪ `history.table` ∪ `pricing.itemTable` — what has to be
  kept fresh, as opposed to what a client may page. The delete guard uses it.
- `cachedLookups` splits in two on purpose: the canonical resolve is memoized per (tenant, model,
  masterdata version), and `bindEntryValues` — which loads the rows a *stored* configuration names
  past the canonical page — stays uncached, because entries are unbounded user input and a key that
  grew with them would leak.

## Writing to SAP

- **ETag always.** Updates carry `If-Match`; a 412 surfaces as `CONFLICT`. There is no force path.
- **Curated-only.** `entity-profiles.ts` names four entities (Quotations, Orders,
  BusinessPartners, Items) and the exact fields on each; the rule is enforced in
  `orpc/routers/entities.ts`, not by which buttons a page draws. Everything else B1 exposes is
  read-only — DeliveryNotes and Invoices included, which stay copy targets.
  `entities.metadata` hands the same rule to the browser as per-field `Editable`/`Required`
  (`toConstraints`), so the form and the allowlist cannot drift.
- **Idempotent quote write-back.** `configDocumentCommandId()` (SHA-256 over
  `tenant|project|canonicalJson(selected assignments)`, keys sorted because Postgres reorders
  jsonb) is written to `U_CF_Key` and checked before create. It hashes the selected
  *assignments*, not their indices — an index only means something against the candidate list that
  produced it, and a recalculate replaces that list. `config_project.b1DocEntry` covers a double
  click; the UDF covers the case where B1 created the document and the response never arrived.
  A missing UDF **refuses to run** rather than risk a double-post — see `docs/sap-b1-durable-writes.md`.
  `createQuote` (`config-quote.ts`) is create-**or-modify**: a reopened request re-quotes its open
  quotation in place (PATCH + If-Match + replaced lines + a rewritten key; a 412 whose re-read shows
  our key is the lost-response success), and posts a new one once B1 has closed it — then the hash
  covers the replaced `DocEntry` and the pre-check excludes it. Staff close a quotation with
  `entities.close`. The §16 behaviours of a live B1 are marked `unverified (spec §16)` in code.
- **Document copy** (`doc-copy.ts`): target lines carry `BaseType`/`BaseEntry`/`BaseLine` — that is
  what makes B1 close the source lines instead of creating an unlinked document. The line field
  list is an allowlist; `BaseLine` is the source `LineNum`, not the array index.

## List Report / Object Page

Copied from the Beas client (`LIST-REPORT-OBJECT-PAGE.md`, `VALUE-HELP-AND-KEY-NAVIGATION.md`):
two shells in `packages/ui/src/` (`@confire/ui`, imported by path: `@confire/ui/list-report/ListReport.tsx`)
driven by **declared** per-entity configs. Metadata never
generates a page.

- **The data source is injected.** The shells never import an app's oRPC client: they read and write
  through `UiSource` (`source.tsx`) — the internal router's own client and query utils, provided once in
  `apps/app/src/main.tsx`. The query keys therefore stay the app's, so the app's own cache writes
  (`QuoteCreatePage` seeding `entities.one`) still land. `global.css` (UI5 quirks the shells need) lives
  there too. `bun run test:ui` runs its tests. The portal provides its own (`apps/portal/src/main.tsx`):
  value help over `projects.queryPage`, personal views only.
- **Shared beyond the shells:** `configurator/` (`ConfiguratorForm`, `ConfigTable`: both draw a server
  form state — the preview's is built locally — and report each change; `patch.ts`, the patch merge and
  the one-in-flight queue both SPAs send through), `money.ts`,
  `timeline/` (`ProjectTimeline`, `PROJECT_STATUS`) and `confirm.ts`'s `promptNote`.
- **Features are declared.** `apps/app/src/features/b1/` (documents, business partners, items; `B1_FEATURES`
  is the registry — the `/b1/$entity` routes accept nothing else, and the side nav and search list
  it). A feature is plain object literals: list columns, filter fields, system views, header, section
  tree. Local lists (configs, models, masterdata) declare theirs in the route file.
- **Metadata only merges** (`metadata.ts`, Beas `ii`/`rg`): label, type, options and
  MaxLength fill what a declared field left out; `Required` becomes `required` unless the field
  declared a function; editability is `isEditMode && Editable && !readonly` (on create, `Required`
  counts too). The one thing metadata adds: `U_` fields as hidden columns and an auto
  "User-defined fields" section. Enum options carry B1's member *name* (`bost_Open`) — that is what
  the Service Layer sends and filters on.
- **One combined view per list** (`views.ts`): layout + filters in one `ViewState`, Beas'
  own field names. System views are code (`system:<key>`, Standard first unless a feature declares
  `default`); personal/shared ones are `ui_view` rows, the active one per user a `ui_user_state`
  key. Dirty is a canonical-JSON compare — jsonb reorders keys. On first load the URL's filters
  win (`?CardCode=C1,C2`, `?DocDate=a~b`); Go and view switches rewrite it.
- **`ListQuery` is the wire query.** `toQuery` turns a state into it (range → ge/lt-next-day, list
  → `in`, string → `contains`/`eq` for `exact`); `entity-list.ts` compiles it to OData,
  `list-sql.ts` to SQL. `ListReport` does no client-side processing (`manualSortBy`), so both match.
- **Value helps are CFLs** (`cfl/`): `cfl-configs.ts` factories, one `fetchPage` over an
  entity source (`entities.rows`) or a masterdata source (`configs.queryPage`, with an exact
  `match` for probes). The key is `keyField ?? columns[0]`. A failed existence probe counts as
  "exists". Type-ahead is `startswith`, the dialog `contains`.
- **Templates** are props keyed by id (`cellTemplates`, `filterTemplates`, `sectionTemplates`, …);
  section/group templates get the default `content` so they can wrap rather than replace.
- Deviations from Beas, on purpose: `Editable`/`writable` come from the server; `resolveColumns`
  fills grid columns from metadata; `fixedFilters: FilterCond[]` replaces raw `defaultFilter`
  OData; the value-help dialog persists one layout per user (`cfl:<source>`), not named views;
  document lines are `Grid` in both modes, editable cells as stable per-column templates
  (`EditGrid`; a new Cell component remounts the input under the cursor) with Add line / Delete
  instead of an auto-added draft row; lines are editable on a *new* document only.

One rule worth knowing before editing `compileList`: a **filter** — or a **search field** — naming
a missing field is an error (dropping it would show *more* rows than asked for), a **select** or
**orderby** naming one is silently dropped (a saved view outliving a UDF should still open).

## Conventions

- **`// ponytail:` comments mark deliberate simplifications** and name the ceiling plus the upgrade
  path (`// ponytail: jsonb blob; real tables only if a reader has to filter inside it`). Respect
  them — they are decisions, not oversights. Add one when you take a shortcut with a known limit.
- Comments explain *why*, especially when the obvious approach was tried and failed. Several
  carry verified error strings from a live B1 — do not "clean those up".
- Big configuration objects are one jsonb document loaded and saved whole (`config_model.definition`,
  `ui_view.state`), not modelled tables.
- Imports use explicit `.ts` extensions; `verbatimModuleSyntax` is on, so `import type` matters.
- **UI texts are UI5's i18n** (`@confire/ui/i18n.ts`): each SPA's `src/i18n/messagebundle_<locale>.properties`
  behind its `useI18n()` (`getText("KEY", …)`). English is the base every language is laid over, so a
  partial translation reads in English rather than as keys. The language is UI5's: the browser's, or
  `?sap-ui-language=es`. So far only a few shell texts go through it.
- Workspace packages must be listed as **direct** dependencies — Bun's isolated install does not
  resolve transitives here. Adding an import from a new workspace package means editing that
  `package.json` and re-running `bun install`.
- **A schema change ships as a migration.** Dev syncs with `db:push`; then `bun run db:generate` writes
  `packages/db/drizzle/NNNN_*.sql` (committed) and `deploy/update.sh` applies it with `drizzle-kit
  migrate`, which never prompts — `push` asks about renames and data loss, and an unattended deploy
  cannot answer. CI refuses an image whose schema has no migration. `0000_init` is the baseline: a
  database built by `push` (dev's) has no migration journal, so it keeps using `push`. New schema
  files must be re-exported from `packages/db/src/schema/index.ts`.

## Design docs

`docs/superpowers/specs/` and `docs/superpowers/plans/` hold the design record per feature, dated.
`docs/*.md` are the operator/user guides (model builder, durable writes) — update them when you
change the surface they describe.

---

Note: `~/.codex/config.toml` and `~/.gemini/settings.json` exist on this machine. Reply `/import`
to scan and list what is importable (MCP servers, slash commands, subagents, skills, instructions),
then `/import --yes=<digest>` to apply the user-level items.
