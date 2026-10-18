# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Confire is a multi-tenant SaaS quoting platform for SME manufacturers running on-prem SAP Business One.
`AGENTS.md` describes what the product does in plain language; this file is the technical picture.

## Commands

Everything runs on **Bun** (no npm — see `package.json` workspaces).

```bash
docker compose up -d db                 # Postgres 17 on :5432 (dev runs server/web with bun)
bun install
bun run dev                             # sign in at http://lvh.me:5173; staff app <slug>.app.lvh.me:5173
                                        # (server :3000), portal <slug>.portal.lvh.me:5180 (server :3001),
                                        # agent :4000
bun run db:push                         # drizzle-kit push — the ONLY schema migration 
bun run auth:generate                   # regenerate schema/auth.ts after a Better Auth config change
```

The Better Auth CLI is the `auth` package (`@better-auth/cli` stopped at 1.4). Its version is pinned
in `apps/server/package.json` and moves together with `better-auth`.

There is no lint step. Type-checking is the gate, and it is **per project** — there is no root
tsconfig that covers everything, so a change can typecheck in one package and break another:

```bash
bunx tsc -p apps/server/tsconfig.json --noEmit
# projects: packages/{b1,config-engine,db,ui}, apps/{agent,server,web,portal}
bun --cwd apps/web build                # also regenerates routeTree.gen.ts (gitignored)
bun --cwd apps/portal build             # same, for the portal's route tree
```

Note `apps/server/tsconfig.json` also includes `../../scripts`, so the seed/migration/e2e scripts
are checked there rather than in a project of their own.

## The processes

```
Browser: apps/web (staff)               Browser: apps/portal (the manufacturer's customers)
   │ oRPC over /rpc, same-origin            │ (dev: Vite proxy; prod: each server serves its SPA)
   ▼                                        ▼
Confire server (apps/server/src/index.ts)   Portal server (apps/server/src/portal/index.ts)
   │                        └── Postgres ──┘
   │ HTTPS to the tenant's agentUrl, one named operation per endpoint
   ▼
confire-agent (Bun, on the customer's network) ── SAP B1 Service Layer /b1s/v2
```

The customer portal is a second process from the same image (compose service `portal`, CMD
`start:portal`) so external traffic never shares an event loop with staff. Both are `serve.ts`:
Better Auth on `/api/auth`, oRPC on `/rpc` with the 2 MB body cap, the SPA on the rest. The design
record is `docs/superpowers/specs/2026-10-07-portal-redesign.md`; P0–P5 are built (see its §15).

The agent is a Windows service the customer installs. SAP credentials live in its `agent.json`
and never reach the cloud. `sapConnection.agentUrl` is `http://localhost:4000` in dev and a
Cloudflare Tunnel hostname in production — **that difference is a database row, not a branch in
the code**, which is why nothing here is conditional on "dev vs prod".

## Tenancy is the request host

`<slug>.<APP_BASE_DOMAIN>`. `tenant.ts` parses the slug (the only place the host is parsed);
`orpc/base.ts` joins it against `member` — **the membership join is the tenant boundary**, so a
forged Host can only ever select an org the user already belongs to. Three procedure builders
compose that check:

| Builder | Who |
|---|---|
| `sessionProcedure` | signed in; `me` resolves membership itself |
| `userProcedure` | member of this workspace; a leftover `client` role stays forbidden |
| `adminProcedure` | admin/owner — model builder, settings |

**One sign-in for both** (`docs/superpowers/specs/2026-10-17-single-sign-in-design.md`): one Better Auth
instance (`auth.ts`), one `session` table, one cookie on the sign-in host's domain (`BETTER_AUTH_URL`,
`confire.ai`; dev `http://lvh.me:5173`), which covers both zones. Both processes mount it on `/api/auth`.
A session says who you are, never where you may go: that is the membership join here and the seat join
on the portal. `/login` on the sign-in host is also the **dispatcher** (`sap.lobby` lists the workspace
and every portal seat, with server-built URLs): signed in, it follows a safe `redirect`, else sends the
user to their one place, else renders "Where to?"; no place at all is workspace setup. A portal stays
invite-only because a portal-originated sign-in carries `redirect` back to the portal, whose own guard
shows the invite-only page — sign-in itself cannot know who is "a customer".

**The portal** is the same tenancy pattern on its own zone: `<slug>.<PORTAL_BASE_DOMAIN>`, parsed by the
same `tenantSlugFromHost`. No organization plugin: a customer company is `portal_company` (one per
tenant × CardCode) and a seat is `portal_member`, whose unique `(tenantId, userId)` index is "one
company per user per tenant". Builders (`portal/orpc/base.ts`);
every tenant-scoped one refuses the supplier's own staff (any internal `member` of the host tenant):

| Builder | Who |
|---|---|
| `portalAuthedProcedure` | signed in; no tenant (`lobby`); `me` resolves the rest itself |
| `portalSessionProcedure` | + the host's tenant, maybe no seat yet |
| `portalMemberProcedure` | + a seat: `portal_member ⋈ portal_company` on that tenant |
| `portalBuyerProcedure` / `portalOwnerProcedure` | seat role `buyer`/`owner` / `owner` |

**`portal/members.ts` is the only writer** of `portal_member` (`addPortalMember`), `portal_company_domain`
(`claimDomain`) and `portal_invitation` (`sendInvitation`, `cancelInvitations`), and both processes
import it. The internal router (`orpc/routers/portal.ts`: `portalInvitations`, `portalCompanies`)
and the portal's (`onboarding`, `company`) therefore enforce one rule set. The rules:
- "One open invitation per email" is a partial unique index. Expired rows are still `pending`, so a send cancels them first.
- A second way into the same company never lowers a role.
- No change may leave a company that had an owner with none.
- Free-mail domains are never registered or auto-joined.
- Staff and customer of one tenant are mutually exclusive: `addPortalMember` refuses staff, and the
  internal `beforeAcceptInvitation` refuses a portal customer.

Ways in are an invitation (`/accept/<id>`, existing-BP from the BP Object Page's *Invite to portal*)
or auto-join (`onboarding.join`, a verified address on a domain registered to a company).
`bun run seed:portal` gives a dev tenant a company and an owner login.

**Portal projects** (spec §7): a published model (`config_model.portal`, set by `models.publish`, not
by `save` — publishing must not bump `updatedAt`) becomes a client's project, `config_project` with
`portalCompanyId` set. **The engine runs on the server**: `portal/orpc/projects.ts` returns the
projection in `portal/projection.ts` (pure, tested) and never a `ModelDef`, lookups or a candidate —
that module is the fence in both directions (`acceptPortalInputs` is what a client may write).
**`project-lifecycle.ts` is the only writer of `status` and `config_project_event`**, imported by
both processes: `transition()` locks the row and writes the status and its events in one
transaction; `assertWritable(…, actor)` + `writableBy(side)` say who may edit in which status; an
internal read never sees a client's draft (`internalVisible`). Staff work requests in Portal →
Requests (`orpc/routers/requests.ts`) and on the existing process page. The timeline is
`project-timeline.ts`: events from Postgres, SAP document chains as a separate live read.

**Portal documents** (spec §13.1): a client's own quotations, orders, deliveries and invoices.
`portal/doc-fields.ts` is the one field rule — `ALWAYS` (DocNum, status, total…), `NEVER` (CardCode),
a cost/margin/purchase-price denylist and code defaults — and `portalSchema` applies it **on read**,
so a stale setting cannot expose a field. `portal/orpc/docs.ts` fences every read: `rows` passes
`CardCode eq '<company>'` as `readRows`' `extraFilter` and seals its cursor to `portal:<companyId>`;
`one`, `print` and `project` read the document's CardCode before returning anything. `docs.project`
walks back through the lines' `BaseType`/`BaseEntry` to the quotation a project quoted. Admins pick
fields in Settings → Portal (`portalSettings`, one jsonb `portal_settings` document; P5 writes
`docFields`). The portal plugs `docs.*` into `UiSource`, so the shells run unchanged. Print is Preview
only, in both apps (`@confire/ui/PrintActions.tsx`).

There is no bot check and no supplier branding on sign-in: account mail is always Confire's. Host
rules for both SPAs (slug, the sign-in host's URLs, `safeRedirect` — anything under the sign-in host's
domain) are `@confire/ui/host.ts`; `VITE_AUTH_URL` is baked into both builds.

Dev signs in at `http://lvh.me:5173` (public DNS: lvh.me at any depth → 127.0.0.1); the staff app is
`<slug>.app.lvh.me:5173`, the portal `<slug>.portal.lvh.me:5180`, and the `.lvh.me` cookie reaches both
(cookies ignore ports). Not `localhost`: the browser treats it as a TLD, so a `.localhost` cookie never
reaches `acme.localhost`. Not `confire.localhost` either — the cookie works, but Google rejects
`http://*.localhost` OAuth redirect URIs. Not `.local`: that is mDNS, and nss-mdns answers it before
`/etc/hosts` is read.

Prod is one `DOMAIN=confire.ai` in compose: sign-in (and later marketing) on `confire.ai`,
`APP_BASE_DOMAIN=app.confire.ai`, `PORTAL_BASE_DOMAIN=portal.confire.ai`; bare `app.`/`portal.`
redirect to `confire.ai/login`. **Every `*.confire.ai` host receives the session cookie: never point a
name under it at a service this stack does not control** (a subdomain takeover would collect sessions).
Caddy: the apex plus one wildcard site per zone, certs via the Cloudflare DNS challenge
(`CADDY_TLS=cloudflare`; see `docker-compose.yml`).

## Mail

`apps/server/src/mail/`: `sendMail` is the seam — Resend when `RESEND_API_KEY` is set, otherwise the
console (the server log prints each mail, links included; tests read `devOutbox`). Sender
`notify@<MAIL_DOMAIN>`, the display name quoted by `formatFrom`. Templates are React Email
components (`react-email`, pinned: 6.11.3 requires a `@react-email/render` that was never
published), one typed props object each, drawn in `layout.tsx`'s frame with a `Brand`. Sends are
fire-and-forget and never throw — a mail is never on a request's critical path.

Email + password sign-in requires a verified address (`requireEmailVerification`): sign-up returns
no session, and an unverified sign-in is refused with `EMAIL_NOT_VERIFIED` after mailing a fresh
link (`sendOnSignIn`). The test harness verifies its users directly before signing them in.

## `packages/config-engine` — the calculation core

Pure, dependency-free (zod only), and the same code runs in the browser for live preview and on
the server for the numbers that get stored. **Never trust the browser's figures**: handlers
recompute.

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
shape. It is also what keeps `prices` small enough to send to the browser. An item with no line for
the price list costs 0 and its BOM line is flagged `unpriced`; the process page names each one as a
warning, so one missing price never stops a calculation (or offline work). The item query declares
**no columns** on purpose: `columns` becomes `$select`, `ItemPrices` is a complex collection B1 rejects
selecting, so the read asks for whole rows and the cache stores them raw.

**Nothing is snapshotted.** One configuration is one row: `config_project` carries its own
`entries` + `candidates` + `selection`, and a recalculate overwrites them in place. Model and
lookups are resolved on every read (`liveEngine` in `config-project.ts` — the engine's server half,
out of the router so the portal process can import it without the internal auth), so a quoted
configuration is re-priced against what the cache says now rather than what it said then —
`quotedValue`/`quotedCost` are the only frozen numbers, captured for the dashboard. (A portal
submit freezes the client's inputs and indicative prices — on its append-only event row, not the
project.)

**Inputs and candidates move in one statement.** `candidates` is emptied in the same `UPDATE` that
writes `entries`/`batches`/`tables`, so a reader sees either the old inputs with their candidates or
the new inputs with none — never a mismatched pair. That is why there is no `calculated` status:
`calculatedAt !== null` is the whole freshness signal. Who may write a project's inputs is
`assertWritable` (`project-lifecycle.ts`): an internal configuration until it is quoted, a client's
request only in the status that is that side's (§7).

**One edit is one call.** `configs.calculate` writes the inputs and recomputes in a single handler,
and returns exactly what `configs.get` returns; `update`/`select` return the same payload.
The client sets its query cache from the response (`setProject` in `ConfigProcessPage.tsx`) rather
than invalidating, so the page holds one `draft` object and `draft !== null` is its whole dirty
check.

## `packages/b1` — the SAP connector

Ported from the vendored `b1-mcp-server/` (MIT, SAP's sample). The MCP *protocol* is deliberately
not in the data path — its write layer is elicitation-gated, has no ETag handling anywhere, and
never parses `NavigationProperty`. The *services underneath* it are what got ported.

- `query.ts` is the **only** module that builds a Service Layer URL. Everything else passes data.
- `B1Transport` is the seam: `DirectTransport` (agent → Service Layer) and `RemoteTransport`
  (cloud → agent) implement the same named methods. **Cloud call sites never see a URL.**
- There is deliberately **no `readAll`**. `readPages(t, set, q, { maxPages })` takes a *required*
  cap so an unbounded fetch can never hide behind an innocent-looking line.
- `readNext` is the one method taking a B1-supplied URL; the agent origin-checks it.
- `action(set, key, name)` is a bound document action (`Quotations(5)/Close`); the agent allowlists
  the names again on its side. `updateEntity(…, { replaceCollections })` sends
  `B1S-ReplaceCollectionsOnPatch` so a PATCHed `DocumentLines` replaces the stored lines.
- `metadata.ts` parses EDMX with `fast-xml-parser` into plain JSON (SAP's parser builds `Map`s,
  which neither cache in jsonb nor cross the wire) and adds `ReferentialConstraint` parsing —
  that is what yields `CardCode → BusinessPartners` and makes the entity UI possible.

Deliberate fixes on port, all load-bearing: `getSetCookie()` (splitting on `,` shreds
`Expires=Wed, 09 Jun …` and loses `ROUTEID`, which a load-balanced Service Layer requires); one
in-flight login promise (N cold requests otherwise burn N B1 licence slots); `buildKeyValue`
(escapes quotes, handles composite keys); `B1Error{status, code}` instead of `Error(string)`;
Bun's `tls: { rejectUnauthorized: false }` — **Bun's `fetch` ignores undici's `dispatcher`**, so
the sample's self-signed handling is a silent no-op here.

Beas is not a second package: it is the same `ServiceLayer` with a different `basePath`/`auth`
and a different agent route prefix.

## Live queries are data, not paths

`config_masterdata.query` is `{ entitySet, filter?, orderby? }` plus the display-only `labels`/
`hidden` and the `syncMinutes` staleness setting. `$select` is **derived from `columns`** and never
stored, so the two cannot disagree. Value-help paging uses a `$skip` offset — a cursor that can
express nothing but paging.

`apps/server/src/b1.ts` is where a tenant becomes transports: `tenantConnector` → `runnerFor`
(the `QueryRunner` seam, which only the **sync** and the editor's live preview still hold) and
`toOrpcError` (B1 status/code → `ORPCError`, a lookup rather than a regex over a message).
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
  `apps/web/src/main.tsx`. The query keys therefore stay the app's, so the app's own cache writes
  (`QuoteCreatePage` seeding `entities.one`) still land. `global.css` (UI5 quirks the shells need) lives
  there too. `bun run test:ui` runs its tests. The portal provides its own (`apps/portal/src/main.tsx`):
  value help over `projects.queryPage`, personal views only.
- **Shared beyond the shells:** `configurator/` (`ConfiguratorForm`, `ConfigTable`: the internal page
  computes in the browser; the portal passes server-evaluated `badges`/`evaluated` instead), `money.ts`,
  `timeline/` (`ProjectTimeline`, `PROJECT_STATUS`) and `confirm.ts`'s `promptNote`.
- **Features are declared.** `apps/web/src/features/b1/` (documents, business partners, items; `B1_FEATURES`
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
  path (`// ponytail: jsonb blob; real tables only if the dashboard needs drill-down`). Respect
  them — they are decisions, not oversights. Add one when you take a shortcut with a known limit.
- Comments explain *why*, especially when the obvious approach was tried and failed. Several
  carry verified error strings from a live B1 — do not "clean those up".
- Big configuration objects are one jsonb document loaded and saved whole (`config_model.definition`,
  `ui_view.state`), not modelled tables.
- Imports use explicit `.ts` extensions; `verbatimModuleSyntax` is on, so `import type` matters.
- Workspace packages must be listed as **direct** dependencies — Bun's isolated install does not
  resolve transitives here. Adding an import from a new workspace package means editing that
  `package.json` and re-running `bun install`.
- `packages/db/drizzle/` is gitignored; schema changes ship via `bun run db:push`, and new schema
  files must be re-exported from `packages/db/src/schema/index.ts`.

## Design docs

`docs/superpowers/specs/` and `docs/superpowers/plans/` hold the design record per feature, dated.
`docs/*.md` are the operator/user guides (model builder, durable writes) — update them when you
change the surface they describe.

---

Note: `~/.codex/config.toml` and `~/.gemini/settings.json` exist on this machine. Reply `/import`
to scan and list what is importable (MCP servers, slash commands, subagents, skills, instructions),
then `/import --yes=<digest>` to apply the user-level items.
