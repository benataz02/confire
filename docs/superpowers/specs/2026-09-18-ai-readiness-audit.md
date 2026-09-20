# AI Tool Conversion Readiness — Audit

**Date:** 2026-09-18
**Scope:** the configuration process and every code path it touches, assessed for conversion into
LLM-callable tools.
**Target features driving the assessment** (from `prompts/ai-agent.md`):

| # | Feature | Short name used below |
|---|---|---|
| A | Extract values from technical drawings and feed the configurator, given the model, domains and rules | **Extraction** |
| B | SAP B1 document suggestions + similar configurations as reference | **Recall** |
| C | SAP B1 quotation creation from a configuration | **Quote** |
| D | First-party MCP servers so ChatGPT / Claude Code / other clients can drive Confire | **MCP** |

**Method:** full read of `packages/config-engine`, `packages/b1`, `packages/db/src/schema`,
`apps/server/src` (all of it), `apps/agent/src`, and the configurator surface of `apps/web`.
No git history consulted — this is a from-scratch assessment of the tree as it stands.

---

## 1. Executive verdict

**The calculation core and the write boundary are already tool-shaped. The identity layer is not.**

Confire was built around a set of seams — `ResolvedLookups`, `QueryRunner`, `B1Transport`, the four
oRPC procedure builders, and the "handlers recompute, the browser never persists a number" rule —
that happen to be exactly the seams an agent needs. Roughly 70% of the work an AI-native rewrite
would normally require is already done, and was done for other reasons.

What is genuinely missing is not in the engine. It is:

1. **No machine identity.** Every procedure requires a Better Auth browser cookie session resolved
   against a tenant *subdomain*. An MCP client cannot authenticate at all today.
2. **No runtime output contracts.** `.output()`, `.meta()` and `.route()` appear **zero times** in
   `apps/server/src`. Tool schemas and OpenAPI generation have nothing to read.
3. **No file ingress.** Extraction needs a drawing; there is no blob store, no upload route, and a
   hard 2 MB cap on the entire RPC surface (`apps/server/src/index.ts:10`).
4. **No AI dependency of any kind.** `GEMINI_API_KEY`, `GEMINI_MODEL` and `ANTHROPIC_API_KEY` sit in
   `.env` and are read by nothing.

### Readiness scorecard

| Area | State | Note |
|---|---|---|
| Calculation core (`config-engine`) | 🟢 Ready | Pure, zod-schema'd, dependency-free, fully deterministic |
| Domain/rule exposure for a prompt | 🟢 Ready | `ModelDefZ` + `configs.lookups` already return exactly what a prompt needs |
| Agent feedback loop (why a value failed) | 🟢 Ready | `propagate()` returns `conflicts` + per-option `eliminatedBy` |
| Write safety / anti-hallucination | 🟢 Ready | Server recomputes; client numbers are structurally un-persistable |
| Quote idempotency | 🟢 Ready | SHA-256 command id + B1 UDF check-then-create + `b1DocEntry` |
| SAP write boundary | 🟢 Ready | Allowlist in the router, not the UI — an MCP tool inherits it for free |
| Business logic reusable outside HTTP | 🟢 Ready | Already exported as `(tenantId, …)` functions for `portal.ts` |
| Recall (history + doc history) | 🟡 Usable | Works; string-weighted scan only, no semantic path |
| Tool schemas / descriptions | 🟡 Mechanical gap | No `.output()`, no `.meta()`, no descriptions |
| Entries validation | 🟡 Real gap | `EntriesZ` is an open record — unknown keys are accepted and stored |
| Domain completeness for a prompt | 🟠 Correctness trap | `configs.lookups` returns **one 100-row page** of a query table |
| Streaming / conversations / runs | 🔴 Absent | Nothing; no SSE use, no message store |
| File ingress for drawings | 🔴 Absent | No storage, 2 MB global body cap |
| Machine auth (API keys / OAuth) | 🔴 Absent | Cookie sessions only |
| Rate limiting / cost control | 🔴 Absent | Nothing bounds an agent loop over live-SAP endpoints |
| Provenance / AI acknowledgment | 🔴 Absent | `events` records status transitions only, never field authorship |

---

## 2. The system as an AI integrator sees it

```
Browser ──oRPC /rpc──► Confire server (Bun + Hono) ──HTTPS──► confire-agent ──► SAP B1 Service Layer
                              │
                              └── Postgres (config_model, config_project, config_masterdata, config_history)
```

The three facts that matter most for tool design:

**Fact 1 — a configuration is one mutable row, and nothing is snapshotted.**
`config_project` (`packages/db/src/schema/configurator.ts`) carries its own `entries` + `batches` +
`tables` + `candidates` + `selection`. A recalculate overwrites them in place. Model and lookups
resolve *live* on every read (`liveEngine`, `configs.ts:145`). There is no run history and no
version chain.

*Consequence for AI:* a tool call has no "run id" to attach to, and there is no place to record
what an agent proposed versus what a human accepted. Any AI feature that needs "show me what the AI
changed" has to introduce that storage; it cannot be derived.

**Fact 2 — inputs and candidates move in one statement.**
`candidates` is emptied in the same `UPDATE` that writes `entries`/`batches`/`tables`
(`configs.ts:688` and `calculateProject` at `configs.ts:161`). `calculatedAt !== null` is the whole
freshness signal.

*Consequence for AI:* there is no torn-read window for a tool to observe. Concurrent agent and
human edits produce a last-writer-wins row, never a mismatched pair. This is stronger than most
codebases offer and needs no change.

**Fact 3 — one edit is one call.**
`configs.calculate` takes `{ id, entries?, batches?, tables? }`, writes them, recomputes, and
returns exactly what `configs.get` returns. This is already a tool signature.

---

## 3. What is already tool-shaped (🟢)

### 3.1 The business logic is not trapped in handlers

This is the single most valuable pre-existing property. Because `portal.ts` had to reuse the
internal configurator, the logic was extracted into exported functions that take `tenantId` as a
plain argument:

| Function | File | Shape |
|---|---|---|
| `calculateProject(tenantId, projectId, run?)` | `configs.ts:161` | write + enumerate + price |
| `liveEngine(tenantId, project)` | `configs.ts:145` | model + resolved lookups |
| `enrichedLookups(tenantId, model, entries, …)` | `configs.ts:101` | domains/tables/prices |
| `queryTablePage(tenantId, input, scopeTo?)` | `configs.ts:127` | searchable value-help page |
| `fetchDocHistory(tenantId, projectId, itemCodes)` | `configs.ts:227` | live B1 orders + quotations |
| `searchSimilarRows(tenantId, projectId, entries)` | `configs.ts:263` | ranked historic rows |
| `quoteDraft(tenantId, projectId)` | `configs.ts:303` | what will be posted + command id |
| `createQuote(tenantId, input)` | `configs.ts:318` | idempotent B1 write-back |
| `applySelection(model, lookups, candidates, selection, tables)` | `configs.ts:397` | pure |

An AI tool layer calls these directly. **No HTTP hop, no logic duplication, no second tenant
boundary to get right** — `tenantId` is already the parameter. This is the difference between a
two-week integration and a two-month one.

### 3.2 `ModelDef` is the prompt artifact, and it already exists

`ModelDefZ` (`packages/config-engine/src/model.ts:226`) is one zod v4 schema describing the whole
model: `parameters` (with `type`, `ui`, `domain`, `unit`, `help`, `mandatory`), `constraints`
(expression and combination-table forms), `computed`, `tables`, `bom`, `routing`, `pricing`,
`structure`.

The feature brief asks to give an LLM "the configurator model, domains and rules". That artifact is
not something to build — it is one jsonb column, validated by one schema, and zod v4 can emit JSON
Schema from it directly.

`checkModel` (`check.ts:53`) is the gate on save (`models.ts:65`). **A model that saved cannot
produce a parse or unknown-reference error at runtime.** An AI tool reading a model can therefore
trust every expression in it parses and every identifier resolves — a guarantee worth a great deal
when the model is going into a prompt.

`portal.ts:146` (`toPortalModelDef`) already demonstrates the allowlist projection that strips cost
expressions (`bom: []`, `routing: []`, `pricing.priceExpr: "0"`) with an explicit field list and a
deliberate no-spread so a future `ModelDef` field defaults to *excluded*. That is the exact pattern
an LLM-facing projection should reuse — especially if the model provider is third-party.

### 3.3 `ResolvedLookups` is the domain seam, and it is already an endpoint

```ts
type ResolvedLookups = {
  domains: Record<string, Option[]>;          // param key -> allowed values
  tables:  Record<string, ResolvedTable>;     // masterdata, manual or live B1
  prices?: Record<string, number>;            // item code -> unit price
};
```

`configs.lookups` returns it whole. The engine never learns where an option came from — manual
list, tenant table, or live Beas read all arrive in the same shape. An extraction prompt needs
`domains` and nothing else.

*(But see §5.1 — `domains` is truncated for query-backed tables. This is the most important
correctness finding in the audit.)*

### 3.4 `propagate()` is a ready-made agent feedback signal

```ts
type Propagation = {
  values, defaulted, visible,
  domains: Record<string, DomainOption[]>,   // DomainOption = { value, label, eliminatedBy? }
  conflicts: { message: string; path: string }[],
  open: string[],                             // parameters still unbound
  candidateEstimate: number,
};
```

`eliminatedBy` carries the *constraint's own message* (`propagate.ts:221`, `:239`) or
`"combination table (a, b)"`. So when a model proposes `material = "X"` and it is impossible, the
system can answer **why**, in the model author's own words, without any new code.

This is the loop-closing signal that agent architectures normally have to invent. It exists because
the UI wanted tooltips.

`conflicts` additionally carries a `path` (`constraints[3]`, `parameters.width`), which is a
machine-addressable pointer — exactly what a tool result should return instead of prose.

### 3.5 The write boundary is structurally safe against hallucination

Three independent mechanisms, all pre-existing:

1. **Handlers recompute.** `configs.select` (`configs.ts:718`) persists only
   `candidateIdx`/`batchQty`/`overrides` and recomputes totals itself; `createQuote` rebuilds every
   line from the persisted project via `buildQuoteSeed`. A model cannot write a number into SAP.
2. **`QUOTE_HEADER`** (`config-quote.ts:76`) is read off `ENTITY_PROFILES.Quotations.editable` and
   deliberately excludes `DocumentLines` and the dedup UDF. `createQuote` **refuses** (does not
   silently drop) any other key — `configs.ts:323`.
3. **`assertConfigMutable`** (`config-quote.ts:232`) locks a quoted project against every mutation.

### 3.6 Quote write-back is already idempotent — the hard part of agent tool design

`configDocumentCommandId` (`config-quote.ts:34`) is SHA-256 over
`tenant|project|canonicalJson({sel, tables})`, with keys sorted (because Postgres reorders jsonb)
and hashing the **assignments, not the indices** — because an index only means something against
the candidate list that produced it.

It is written to `U_CF_Key` on the B1 document and **checked before create** (`configs.ts:345`).
`config_project.b1DocEntry` covers a double click; the UDF covers "B1 created it and the response
never arrived". A missing UDF **refuses to run** rather than risk a double-post.

An agent retrying a failed tool call cannot create a second quotation. Most projects have to build
this *for* agents. Here it is already load-bearing.

### 3.7 Every SAP read is injectable, so AI tools are testable offline

`QueryRunner` (`lookups.ts:32`) is the seam every pure module is written against; production builds
it with `runnerFor(connector)` (`b1.ts:114`) and every test fakes it
(`apps/server/test/mock-agent.ts`). `B1Transport` (`packages/b1/src/types.ts:48`) is the same idea
one layer down. **Cloud call sites never see a URL.**

AI tool tests need no live SAP and no live LLM — both ends are already injectable seams.

### 3.8 Tenancy is middleware composition

Four builders in `apps/server/src/orpc/base.ts`: `sessionProcedure`, `userProcedure` (one line
fences the `client` role out of every internal endpoint, `:54`), `adminProcedure`, `clientProcedure`.
The membership join in `membershipFromHost` (`:30`) **is** the tenant boundary — a forged Host can
only select an org the user already belongs to.

Adding a machine caller means adding a fifth builder, not touching 40 handlers. The boundary logic
is already in one function.

### 3.9 SAP error mapping is a lookup, not a regex

`toOrpcError` (`b1.ts:79`) maps B1 status/code to `ORPCError` by `switch (true)` over status. For an
agent loop the retryable/terminal split matters, and the classification already exists in one place
— `SERVICE_UNAVAILABLE` (agent down) is already distinguished from `BAD_REQUEST` (SAP rejected the
payload) and `CONFLICT` (ETag). Extend, do not invent.

---

## 4. Mechanical gaps (🟡) — structurally fine, work required

### 4.1 No runtime output contracts anywhere

`.output(` , `.meta(` and `.route(` return **zero matches** across `apps/server/src`. Every
procedure declares `.input(zodSchema)` and returns an inferred TypeScript type.

Consequences:
- An OpenAPI document generated from the contract (`@orpc/openapi`, currently at 1.15.1 against the
  installed `@orpc/server` 1.14.6) would emit `unknown` for every response.
- MCP tool definitions need a result schema to be useful to a model; there is nothing to derive one
  from.
- There is no place to hang a tool *description*. The code comments in this repo are excellent and
  would make good tool descriptions — but they are comments, not data.

This is mechanical, not architectural: the return shapes are stable and small. It is the single
highest-leverage piece of prep work.

### 4.2 Entries accept unknown keys and untyped values

`EntriesZ` (`model.ts:7`) is `z.record(z.string(), ValZ | string[])` — **any key, any value**.
Nothing between the wire and the database checks an entry key against `model.parameters`, in either
`configs.calculate` (`configs.ts:688`) or `portal.projects.update` (`portal.ts:390`).

For a human UI this is unreachable: the form writes only known keys. For an LLM it is a matter of
time. `entries: { "wdith": 50 }` is accepted, stored, and silently does nothing — `bindings()` puts
it into the expression scope as an unused variable and `tryEval` swallows the rest.

Similarly, values are not coerced to `Param.type`. `{ width: "50" }` (string, not number) is stored
and then fails at calculate time with `expected number, got "50"` from a DSL evaluation deep inside
`computeOutputs` — a correct failure, but one that names an expression rather than the input that
caused it.

**This is the clearest concrete gap in the configuration process itself.** A guard in one place
(the shared write path) fixes it for the UI, the portal, and every future AI tool at once.

### 4.3 No provenance

`config_project.events` is `{ at, kind, note? }` with `kind` restricted to
`created|submitted|withdrawn|rejected|quoted`. It records status transitions, never field
authorship.

SAP Fiori's AI guidance (`references/foundations-ai-and-joule-design.md`) treats an explanation
indicator as **Level 1 — the minimum required whenever an ML or LLM output is presented**, with a
Level 2 "why" popover behind it. Neither is derivable from the current schema: there is nowhere to
record that `width` came from a drawing at 0.82 confidence while `material` was typed by a human.

### 4.4 Agent-hostile dead ends in the enumerate path

`enumerate` (`enumerate.ts:12`) caps at 200 candidates and returns
`{ candidates, capped, widest }`. When nothing completes, `calculateProject` throws
`BAD_REQUEST: "No valid configuration completes the current entries"` (`configs.ts:199`).

That message is a dead end for an agent: it names nothing to relax. `propagate`'s `conflicts` (with
`message` + `path`) and per-option `eliminatedBy` are far richer and are computed on the line above
(`configs.ts:192`) — but only surfaced when `pre.conflicts` is non-empty. An AI-facing diagnosis
tool should lead with propagate, not enumerate.

Performance note for loops: `propagate` calls `evalWith` (`propagate.ts:128`), which runs a full
`bindings()` pass per candidate value per constraint, inside a loop bounded at 50 iterations. An
agent that recalculates on every proposed field will pay this repeatedly. The browser already
auto-calculates ~1s after each keystroke, so the path is exercised — but a human types slower than
a model.

### 4.5 Recall is a string-weighted full scan

`scoreRows` (`similarity.ts:17`) is pure, weighted, self-normalizing for `closeness` matches, and
capped at top-10. `loadHistoryRows` (`history-sync.ts:17`) pulls every row for the model out of
`config_history` behind a 5-minute cache.

It works and is honestly labelled (`ponytail: … real columns/pgvector if a tenant outgrows
in-process scoring`, `configurator.ts:122`). But it matches on *mapped columns*, exact/contains/
closeness only. There is no semantic path — "customer asked for a stainless flange, roughly
DN100" cannot reach it without the LLM first decomposing the request into mapped parameters.

Whether that is a gap depends entirely on whether Recall is meant to be LLM-driven free text or
LLM-driven-after-extraction. **Q&A item.**

### 4.6 `b1-mcp-server/` is vendored but deliberately out of the data path

The tree contains the full MIT SAP sample (`b1-mcp-server/`, with `@modelcontextprotocol/sdk`,
elicitation, tool registry, discovery handlers). `packages/b1` is a port of its *services*;
`CLAUDE.md` is explicit that the MCP protocol was left out on purpose — the sample's write layer is
elicitation-gated, has no ETag handling anywhere, and never parses `NavigationProperty`.

For feature D this is a useful reference for MCP server *shape* (tool registry, streamable HTTP
transport, session handling) and a poor one for *content*. The Confire MCP server should expose
Confire's curated operations, not raw Service Layer access — that is precisely the boundary
`entity-profiles.ts` exists to draw.

---

## 5. Blockers (🔴)

### 5.1 Domains handed to an LLM are truncated to one page — correctness trap

`configs.lookups` → `enrichedLookups` → `cachedLookups` → `resolveLookups` (`lookups.ts:341`) →
`addQueryTables` → `fetchQueryTable(run, target, query, columns)` **with no options** →
`runnerFor` clamps the page to `DEFAULT_PAGE` (`lookups.ts:21`, default **100**).

So for a `kind: "query"` masterdata table — a live B1 read, which is the common case for materials,
items, finishes — `domains[param]` holds **the first 100 rows**, not the domain.

For the existing UI this is correct and intentional: the value help pages with `$skip` via
`configs.queryPage`, and `enrichLookups` (`lookups.ts:177`) re-appends off-page rows for values
that were *already persisted*.

**For an LLM it is a trap.** A prompt saying "here are the allowed values for `material`" that
contains 100 of 4,000 rows will produce confidently wrong extractions, or spurious "no match" for
values that exist. `enrichLookups` does not help — it verifies persisted values, not proposed ones.

**An AI-facing resolution tool must be search-backed** (`queryTablePage` with `search`/`searchCols`,
`configs.ts:127`), not domain-dump-backed. This is a design constraint on the Extraction feature,
not a bug to fix in the existing path.

### 5.2 No machine identity — feature D cannot start

Every procedure builder composes `requireSession` (`base.ts:17`), which calls
`auth.api.getSession({ headers, query: { disableCookieCache: true } })`. There are no API keys, no
OAuth client credentials, no bearer tokens, no service accounts for the cloud API.
`grep -niE "ratelimit|apiKey|bearer"` over `apps/server/src` returns **nothing**.

Compounding it: **tenancy is carried by the request Host.** `membershipFromHost` (`base.ts:32`)
reads `x-forwarded-host ?? host` and parses `<slug>.<APP_BASE_DOMAIN>`. An MCP client connecting
over stdio, or over HTTP to a generic endpoint, has no natural reason to send a tenant subdomain.

The *boundary* is sound and should not change — the membership join is the right check. What has to
change is the **carrier**: how a non-browser caller proves identity and names a tenant. That is a
new procedure builder plus a credential store, not a rework.

### 5.3 No file ingress — feature A cannot start

Extraction needs a drawing. There is:
- no blob storage of any kind (no S3/R2 client, no `bytea` column, no upload table);
- no upload route (`apps/server/src/index.ts` mounts exactly three things: Better Auth, the oRPC
  handler, and static files);
- a **2 MB cap on the entire RPC surface** via `BodyLimitPlugin` (`index.ts:10`), which a
  multi-page technical drawing PDF routinely exceeds.

Note the agent already proves a large-binary path is workable: `printDocument` returns a
SAP-rendered PDF as base64 through `/print` (`apps/agent/src/index.ts:81`). That is an existence
proof of the plumbing, not a reusable ingress.

### 5.4 No AI dependency, and stale env keys

`GEMINI_API_KEY`, `GEMINI_MODEL` and `ANTHROPIC_API_KEY` are present in `.env` / `.env.development`
and are read by **no code in the repository**. Zero AI packages are installed
(`grep -i "openai|anthropic|@tanstack/ai|langchain|modelcontextprotocol"` over `apps` + `packages`
returns only the pgvector ponytail comment).

Per the `tanstack-ai` skill: with nothing installed, `@tanstack/ai` is the right default — typed per
model, provider-agnostic with tree-shakeable adapters, tools defined once for server and client,
and MCP / persistence / memory as separate packages rather than a rewrite later. The package map
relevant here:

| Need | Package |
|---|---|
| Tool calling, agent loops, structured outputs, image input | `@tanstack/ai` |
| Provider | `@tanstack/ai-anthropic` and/or `-gemini` (both keys already in `.env`) |
| Exposing Confire as MCP / consuming MCP | `@tanstack/ai-mcp` |
| Chat UI (`useChat`) when the frontend phase arrives | `@tanstack/ai-react` |
| Server-side run state, resume, durable approvals | `@tanstack/ai-persistence` |

API details deliberately not stated here: the SDK moves fast and the correct source is the
installed package's own skill (`npx @tanstack/intent@latest load @tanstack/ai#ai-core`). Nothing in
this audit should be read as a committed API surface.

### 5.5 No rate limiting or cost control on live-SAP paths

Nothing bounds how often a caller hits an endpoint that makes a live SAP hop. `configs.calculate`,
`configs.lookups`, `configs.queryPage`, `configs.docHistory` and `configs.similar` all reach the
customer's on-prem agent, which holds a **finite B1 licence slot**.

Existing mitigations are real but partial: the 5-minute `lookupCache` keyed on model `updatedAt` +
`masterdataVersion` (`configs.ts:79`), the reuse short-circuit in `calculateProject` (`configs.ts:181`),
`runOnce` memoization inside `resolveLookups` (`lookups.ts:347`), and the single in-flight login
promise in `packages/b1`. None of them bound *call frequency*.

An agent loop is a different traffic shape from a human typist. This needs an explicit answer before
any tool reaches production.

### 5.6 No streaming, no conversation state, no run records

oRPC supports Event Iterator / SSE; nothing in the codebase uses it. There is no message table, no
run table, no place to resume a partially-completed extraction, and no approval record.

Everything in Confire is request/response over a single mutable row. That is a deliberate and good
design for a configurator. It is not sufficient for a multi-turn assistant that asks clarifying
questions — which `prompts/ai-agent.md` explicitly calls for ("In case of doubt, the AI configurator
agent will ask questions to the user").

---

## 6. Per-feature readiness

### A — Extraction (drawing → entries) · **🟠 Blocked on ingress, otherwise well-supported**

| Need | Status |
|---|---|
| Model + rules as a prompt artifact | 🟢 `ModelDefZ`, one jsonb doc, validated on save |
| Allowed values per parameter | 🟠 `configs.lookups` gives one 100-row page for query tables (§5.1) |
| Value resolution from free text | 🟢 `queryTablePage` with `search`/`searchCols` — the right tool |
| Apply extracted values | 🟢 `calculateProject` / `configs.calculate`, one call |
| Validate before applying | 🟢 `propagate()` — conflicts + `eliminatedBy`, no write needed |
| Reject bad keys/types | 🟡 nothing does (§4.2) |
| Accept a drawing file | 🔴 no storage, no upload route, 2 MB cap (§5.3) |
| Record what the AI proposed | 🔴 no provenance (§4.3) |
| Vision-capable model call | 🔴 no AI dependency (§5.4) |

The shape that fits the existing code: **propose → validate with `propagate` → present → apply with
`calculate`**. `propagate` is side-effect-free, so a proposal can be fully checked before anything
is written — which is the right posture for AI-authored input and costs nothing to build.

### B — Recall (B1 documents + similar configurations) · **🟢 Largely ready**

Both halves already exist as tenant-scoped functions:

- `fetchDocHistory` (`configs.ts:227`) — live B1 `Orders` + `Quotations` for the project customer
  and/or the item codes in the items grid, via two parallel `$crossjoin` reads (B1's `$filter` has
  no lambda operators — `doc-history.ts` records the three verified 400s that prove it). Item codes
  are only ever quoted filter values; capped at 20 by the router.
- `searchSimilarRows` (`configs.ts:263`) — `scoreRows` over cached `config_history`, returning
  `score`, per-parameter `matches` (with the match kind and weight that produced them), `display`
  columns, and `values` coerced to each parameter's type — **`values` is literally what the Copy
  button applies**, so it is directly usable as a tool result an agent can hand back to `calculate`.

The per-match breakdown is already a Level 2 "why" explanation in Fiori's terms. Remaining work is
schema/description/exposure, not logic. The only open design question is whether free-text semantic
recall is in scope (§4.5).

### C — Quote creation · **🟢 Ready, and safer than most agent write paths**

`quoteDraft` → `createQuote` is a two-phase commit with a client-echoed `commandId`. A model can
influence *which* selection is quoted and nothing else:

- every number is recomputed server-side from the persisted project;
- `QUOTE_HEADER` refuses unknown header fields by name;
- the SHA-256 command id must match between draft and post, or `CONFLICT: STATE_CHANGED`;
- the B1 `U_CF_Key` pre-check plus `b1DocEntry` make a retry idempotent;
- a missing UDF refuses to run rather than risk a double-post.

The one AI-specific question is **approval**: today a human presses the button. An agent calling
`createQuote` directly writes to the customer's ERP. There is no approval record and no place to
put one (§5.6). **Q&A item.**

### D — MCP servers · **🔴 Blocked on identity**

Everything *behind* a tool is ready — curated operations, tenant scoping as a function argument,
allowlisted writes, idempotent posts. What is missing is the front door:

1. machine credentials (§5.2);
2. tenant selection for a caller with no subdomain (§5.2);
3. result schemas and tool descriptions (§4.1);
4. rate limiting against the licence-slot-bound agent (§5.5);
5. a decision on read-only versus write-capable tools, and per-credential scoping.

The vendored `b1-mcp-server/` is a shape reference only (§4.6).

---

## 7. Findings index

| # | Severity | Finding | Where |
|---|---|---|---|
| F1 | High | `configs.lookups` returns one 100-row page of a query-backed domain; an LLM prompt built from it sees a truncated domain | `lookups.ts:21`, `:341`, `b1.ts:134` |
| F2 | High | No machine identity; every procedure requires a browser cookie session | `base.ts:17` |
| F3 | High | Tenancy carried by request Host; no carrier for a non-browser client | `base.ts:32` |
| F4 | High | No file ingress; 2 MB cap on the whole RPC surface | `index.ts:10` |
| F5 | High | No rate limiting on endpoints that consume a finite B1 licence slot | (absent) |
| F6 | Medium | `EntriesZ` is an open record — unknown parameter keys are accepted and stored silently | `model.ts:7`, `configs.ts:688`, `portal.ts:390` |
| F7 | Medium | Entry values are not coerced to `Param.type`; a type error surfaces later as a DSL error naming an expression, not the input | `output.ts:93` |
| F8 | Medium | No `.output()` / `.meta()` / `.route()` anywhere — no result schemas, no tool descriptions, no usable OpenAPI | `apps/server/src/**` |
| F9 | Medium | `"No valid configuration completes the current entries"` names nothing to relax; the richer `propagate` diagnosis is computed one line earlier and discarded | `configs.ts:192-199` |
| F10 | Medium | No provenance: `events` records status transitions only, so AI-authored fields cannot be marked or explained | `configurator.ts` (`ProjectEvent`) |
| F11 | Low | Recall is exact/contains/closeness over mapped columns; no semantic path | `similarity.ts:17` |
| F12 | Low | `propagate`'s `evalWith` re-runs full `bindings()` per candidate value per constraint; an agent loop amplifies it | `propagate.ts:128` |
| F13 | Low | AI env keys present and read by nothing; no AI package installed | `.env` |

---

## 8. AI-specific risk register

| Risk | Existing mitigation | Residual |
|---|---|---|
| Model invents a price or total | Handlers recompute from persisted state; client numbers never stored | **None** — structurally prevented |
| Model posts a duplicate quotation | SHA-256 command id + `U_CF_Key` pre-check + `b1DocEntry` | **None** — structurally prevented |
| Model writes a field SAP should not accept | `QUOTE_HEADER` / `pickEditable` refuse by name; rule lives in the router | **None** for curated entities |
| Model reaches another tenant's data | Membership join is the boundary; `tenantId` is a function argument everywhere | Low — but a new machine-auth path must compose the same builder, not bypass it |
| Model picks a value outside the real domain | — | **High** (F1): the domain it is shown is truncated |
| Model writes a misspelled parameter key | — | **Medium** (F6): accepted and silently ignored |
| Agent loop exhausts the B1 licence slot | 5-min lookup cache, calc reuse, `runOnce`, single login promise | **Medium** (F5): no frequency bound |
| Cost expressions leak to a third-party model | `toPortalModelDef` shows the projection pattern | Medium: pattern exists, is not applied on any AI path |
| User cannot tell what the AI decided | — | **High** (F10): no provenance, so Fiori Level 1 indicators are not derivable |

---

## 9. What this audit does *not* decide

Deliberately left open for the Q&A session that produces the spec:

1. **Where inference runs** — cloud server, or on-prem agent (drawings may be commercially
   sensitive; the agent already holds the SAP credentials and never lets them reach the cloud, so
   there is an argument for symmetry).
2. **Provider and model** — both `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` are present. Vision
   quality, cost, and data-residency all point different ways.
3. **Per-tenant BYO keys** vs. one platform key with tenant metering.
4. **Whether the agent writes, or only proposes** — and if it writes, whether `createQuote` is ever
   agent-callable without a human press.
5. **Where drawings live** — object store, Postgres, or agent-local (never leaving the customer's
   network).
6. **Whether Recall becomes semantic** (embeddings / pgvector, already flagged as the upgrade path
   in `configurator.ts:122`) or stays parameter-mapped.
7. **MCP transport and credential model** — stdio vs. streamable HTTP; per-user tokens vs. per-tenant
   service accounts; read-only vs. write tools.
8. **Conversation persistence** — whether multi-turn clarification needs durable runs, or whether
   the configuration row plus a transient client-side thread is enough.
9. **How AI contribution is surfaced** — Fiori requires at minimum a Level 1 explanation indicator
   whenever an LLM output is shown; that is a schema decision as much as a UI one.

---

## 10. Bottom line

> The configuration process does not need to be re-architected for AI. It needs a front door
> (machine identity + file ingress), a contract (output schemas + tool descriptions), two guards
> (unknown entry keys, domain truncation), and a memory (provenance + runs).

Everything else — the engine, the seams, the tenant boundary, the idempotent SAP write-back, the
recompute-don't-trust rule, and the `propagate` feedback signal — is already in place and was built
for reasons that happen to be the right ones.
