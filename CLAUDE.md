# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Confire is a multi-tenant SaaS quoting platform for SME manufacturers running on-prem SAP Business One.
`AGENTS.md` describes what the product does in plain language; this file is the technical picture.

## Commands

Everything runs on **Bun** (no npm — see `package.json` workspaces).

```bash
docker compose up -d db                 # Postgres 17 on :5432 (dev runs server/web with bun)
bun install
bun run db:push                         # drizzle-kit push — the ONLY schema migration 
```

There is no lint step. Type-checking is the gate, and it is **per project** — there is no root
tsconfig that covers everything, so a change can typecheck in one package and break another:

```bash
bunx tsc -p apps/server/tsconfig.json --noEmit
# projects: packages/{b1,config-engine,db}, apps/{agent,server,web}
bun --cwd apps/web build                # also regenerates routeTree.gen.ts (gitignored)
```

Note `apps/server/tsconfig.json` also includes `../../scripts`, so the seed/migration/e2e scripts
are checked there rather than in a project of their own.

## The three processes

```
Browser (React + UI5 Web Components)
   │ oRPC over /rpc, same-origin (dev: Vite proxy; prod: server serves the built SPA)
   ▼
Confire server (Bun + Hono)  ── Postgres
   │ HTTPS to the tenant's agentUrl, one named operation per endpoint
   ▼
confire-agent (Bun, on the customer's network) ── SAP B1 Service Layer /b1s/v2
```

The agent is a Windows service the customer installs. SAP credentials live in its `agent.json`
and never reach the cloud. `sapConnection.agentUrl` is `http://localhost:4000` in dev and a
Cloudflare Tunnel hostname in production — **that difference is a database row, not a branch in
the code**, which is why nothing here is conditional on "dev vs prod".

## Tenancy is the request host

`<slug>.<APP_BASE_DOMAIN>`. `tenant.ts` parses the slug (the only place the host is parsed);
`orpc/base.ts` joins it against `member` — **the membership join is the tenant boundary**, so a
forged Host can only ever select an org the user already belongs to. Four procedure builders
compose that check:

| Builder | Who |
|---|---|
| `sessionProcedure` | signed in, not yet a member (invite acceptance) |
| `userProcedure` | internal member; **one line fences the `client` role out of every internal endpoint** |
| `adminProcedure` | admin/owner — model builder, settings |
| `clientProcedure` | portal accounts only, plus their `portalClient` CardCode binding |

Dev uses `lvh.me` (not `localhost`): a `.lvh.me` cookie is shared across subdomains, a
`localhost` one is not. Prod uses Caddy wildcard subdomains → one server.

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
the price list stops the calculation by name rather than costing zero. The item query declares **no
columns** on purpose: `columns` becomes `$select`, `ItemPrices` is a complex collection B1 rejects
selecting, so the read asks for whole rows and the cache stores them raw.

**Nothing is snapshotted.** One configuration is one row: `config_project` carries its own
`entries` + `candidates` + `selection`, and a recalculate overwrites them in place. Model and
lookups are resolved on every read (`liveEngine` in `orpc/routers/configs.ts`), so a quoted
configuration is re-priced against what the cache says now rather than what it said then —
`quotedValue`/`quotedCost` are the only frozen numbers, captured for the dashboard.

**Inputs and candidates move in one statement.** `candidates` is emptied in the same `UPDATE` that
writes `entries`/`batches`/`tables`, so a reader sees either the old inputs with their candidates or
the new inputs with none — never a mismatched pair. That is why there is no `calculated` status:
`calculatedAt !== null` is the whole freshness signal. A quoted project is locked by
`assertConfigMutable`.

**One edit is one call.** `configs.calculate` writes the inputs and recomputes in a single handler,
and returns exactly what `configs.get` returns; `update`/`select`/`reject` return the same payload.
The client sets its query cache from the response (`setProject` in `ConfigProcessPage.tsx`) rather
than invalidating, so the page holds one `draft` object and `draft !== null` is its whole dirty
check. The portal still runs `update` → `run` → `get`: it calculates on a button press, not per
keystroke.

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
- **Curated-only.** `entity-profiles.ts` names ~8 entities and the exact fields on each; the rule
  is enforced in `orpc/routers/entities.ts`, not by which buttons a page draws. Everything else B1
  exposes is read-only.
- **Idempotent quote write-back.** `configDocumentCommandId()` (SHA-256 over
  `tenant|project|canonicalJson(selected assignments)`, keys sorted because Postgres reorders
  jsonb) is written to `U_CF_Key` and checked before create. It hashes the selected
  *assignments*, not their indices — an index only means something against the candidate list that
  produced it, and a recalculate replaces that list. `config_project.b1DocEntry` covers a double
  click; the UDF covers the case where B1 created the document and the response never arrived.
  A missing UDF **refuses to run** rather than risk a double-post — see `docs/sap-b1-durable-writes.md`.
- **Document copy** (`doc-copy.ts`): target lines carry `BaseType`/`BaseEntry`/`BaseLine` — that is
  what makes B1 close the source lines instead of creating an unlinked document. The line field
  list is an allowlist; `BaseLine` is the source `LineNum`, not the array index.

## Saved views (variants)

`ListVariantDef` (select/filter/orderby/search) **is** the query. `apps/web/src/listSpec.ts`
executes it locally over an array (models, configs); `apps/server/src/entity-list.ts` compiles the
identical spec to OData for B1 entities — same spec, same behaviour, two executors. `ListReport`
does no client-side processing (`manualSortBy`/`manualFilters`) so both sources match.

One rule worth knowing before editing `compileList`: a **filter** naming a missing field is an
error (dropping it would show *more* rows than asked for), a **select** or **orderby** naming one
is silently dropped (a saved view outliving a UDF should still open).

## Conventions

- **`// ponytail:` comments mark deliberate simplifications** and name the ceiling plus the upgrade
  path (`// ponytail: jsonb blob; real tables only if the dashboard needs drill-down`). Respect
  them — they are decisions, not oversights. Add one when you take a shortcut with a known limit.
- Comments explain *why*, especially when the obvious approach was tried and failed. Several
  carry verified error strings from a live B1 — do not "clean those up".
- Big configuration objects are one jsonb document loaded and saved whole (`config_model.definition`,
  `ui_variant.definition`), not modelled tables.
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
