# Implementation readiness report: MCP (phase 3)

Target: `docs/superpowers/specs/2026-10-24-ai-assistant-design.md`, lines 359–491 (§4.10 through §10), with
`2026-11-02-b1-tools-design.md` §5.5 as linked context.
Reviewers, each in a fresh context: implementation readiness (completed), codebase details (completed),
style (completed). Round 1.

**Verdict: not ready to build.** §4.10 names the libraries but leaves the decisions that make up phase 3
open: how a bearer token becomes a user, how OAuth is set up and discovered, which procedures are tools,
and what an SAP write means over MCP. Two findings are live in today's code (B1, M3).

Library facts checked by the resolver (2026-11-02, npm and package tarballs), for use in the fixes:

- `@orpc/mcp@2.0.0-beta.45` exists (matches the pin). It needs the MCP SDK v2, `@modelcontextprotocol/server`
  (latest 2.4.0). `McpRegistrar(router, { filter })`, `register(server, { context: (ctx) => … })`. Tool name =
  OpenAPI `operationId`, otherwise the router path joined by `_` (`configs_get`, the same as `tools.ts`).
  `mcp.tool({ annotations: { destructiveHint } })` is the meta for annotations and description overrides.
  A tool call carries only trace headers, so `context.headers` has to be built by the caller.
- `@better-auth/mcp@1.7.7` (matches `better-auth@1.7.7`) gives `mcp({ loginPage, consentPage, resource, … })`
  (an `oauthProvider` configured for MCP, which needs `jwt()`), plus `requireMcpAuth(auth, handler)`. That
  verifies the JWT against the JWKS (signature, issuer, audience, expiry) and answers the 401 with the RFC 9728
  `WWW-Authenticate`. Client registration is opt-in: `cimd()` or dynamic registration.
- The docs do not mention elicitation in `@orpc/mcp`.

## 🔴 Blockers

| ID | Lines | Finding | Raised by |
|---|---|---|---|
| B1 | 361–362; b1 §5.5 | **SAP writes over MCP are undecided, and today's code auto-posts.** `autoWrite` (`auto.ts:44`) returns true when there is no thread, so over MCP, with both switches on, `b1.write`/`b1.copy` post with no file exception. Yet the user's AI reading a client's drawing is the normal case over MCP. In confirm mode a proposal has no way to be posted: `b1.post` is excluded, no page approves a proposal, and elicitation is unverified. Decide: does auto mode apply over MCP, how is a proposal approved, and do the b1 writes ship in phase 3? | readiness, codebase |
| B2 | 372–374 | **The bearer-to-user seam is not designed.** `requireSession` is private and baked into `userProcedure`, and `getSession` does not read an OAuth access token. "The rest of the builders unchanged" is not possible without changing base.ts. Name the mechanism (for example, an `InitialContext` field that only mcp.ts fills, like `assistantThreadId`). The handler must still give `{ session, user }` with a live user read, and must overwrite `x-tenant` with the path's slug. Also: is a cookie session refused on `/api/mcp/*`? | readiness, codebase |
| B3 | 367–369 | **The OAuth setup is left to "load the skills".** Not specified: the plugin options (login and consent page, scopes, lifetimes), the consent page (a new SPA route plus `tenant.ts` `RESERVED`/`host.ts`), the client registration policy (CIMD, open DCR?), `auth:generate` plus migration 0011, and the version pins. | readiness, codebase |
| B4 | 371, 433, 465 | **Is a token bound to a workspace? The doc contradicts itself.** Line 371 says the token says who and the path says where; line 433 tests a token for A refused on B. `organizationLimit` allows staff of one workspace, so the test holds only through membership. §9 line 465 defers "per-workspace MCP resource" to this phase without deciding. | style, readiness, codebase |
| B5 | 366, 393 | **Mount and discovery are not specified.** `serve.ts` sends every unknown GET to `index.html`, so `/.well-known/oauth-protected-resource…` and `/.well-known/oauth-authorization-server` would return HTML. Also unstated: the transport (Streamable HTTP), the route pattern, the origin guard (it blocks browser MCP clients; it is also the DNS-rebinding guard), and whether the 2 MB cap and the `localize`/`onError` interceptors apply. | readiness, codebase |

## 🟡 Majors

| ID | Lines | Finding | Raised by |
|---|---|---|---|
| M1 | 364–366, 375 | **"The same set as §4.5" is not a list of procedures.** `@orpc/mcp` registers bare procedures, and the chat's tools are wrappers. Lost over MCP: the required sources and the margin strip (`sourcedCalculate`), so an external AI can set `margin`; customers-only, three sets and the 20-row cap (`readSap`); `LIST_CAP` (bare lists allow `top` 500); `slimGet`; `via` on create. Give the exact allowlist, and for each lost behaviour, move it into the handler or accept it. | all three |
| M2 | 375–377, 484–486 | **`createQuote` over MCP can post a bad document.** `QUOTE_HEADER` includes `CardCode` and `DocCurrency`, and the CardCode fence covers portal projects only (`config-quote.ts:301`), so an external AI can post a configuration's lines to another customer or currency. §10's claim that a missing field ends in SAP refusing is wrong. `destructiveHint` is a client hint, not a human click (anti-goal line 88). State the exception and the server-side fence. | readiness, codebase, style |
| M3 | b1 §5.5 line 212 | **Stale name: `b1.apply` is `b1.post`.** A deny-list filter written from §5.5 would expose `b1.post`, the approve, as a tool. The filter must be an allowlist. | codebase |
| M4 | 377, 397, 458, 482 | **The External AI switch is under-specified.** Missing: the column (`assistant_settings.mcp`), `assistant.settings`/`saveSettings`, the UI wording in en/es/eu, the refusal code and how it reaches the client, and the check order. Settings already has two switches, so phase 3 makes three. The switch has three names across the doc. | all three |
| M5 | 337–338, 370 | **No UI shows the connector address.** §4.8 promises "the MCP instructions" in the limit refusal. Nothing in apps/app has them. | codebase |
| M6 | 378–379 | **The MCP description of `configs.calculate` has no mechanism.** Editing the `openapi()` meta also changes the chat's tool and the OpenAPI page. Choose between `mcp.tool({ description })` and editing the meta. | readiness, codebase |
| M7 | — | **No rate limit is applied to MCP.** `rateLimit` (20 calls a minute) exists, and every `b1.read` reaches the customer's SAP through the agent. | readiness, codebase |
| M8 | 383–403 | **The file list has one row for phase 3.** Missing: base.ts, auth.ts and the regenerated schema/auth.ts, schema/assistant.ts and its migration, routers/assistant.ts, index.ts/serve.ts, the consent route, tenant.ts/host.ts, AssistantSettings.tsx and i18n, package.json, CLAUDE.md/DEPLOY.md. | readiness, codebase |
| M9 | 405–443 | **Phase 3 has one test and is one undivided step.** Missing tests: 401 plus `WWW-Authenticate`; the switch off refuses; `tools/list` equals the allowlist (no `b1.post`, no admin); a `portal_*` token is refused; the path slug wins over `x-tenant`; no `assistantThreadId` over MCP; the b1 write behaviour; how a test gets a token. Split phase 3 into buildable steps. | readiness, codebase |
| M10 | 359, 393, 403, 433 | **"Second phase"/"phase 2" vs "phase 3".** Line 3 says phases 1–2 are built, so the MCP rows read as built. | all three |
| M11 | 416–422 | The eval's measures are loose ("about zero", "filled share" with no denominator, "about 30"). Built phase; outside MCP. | style |

## 🟢 Nits

- N1 (364): state `@orpc/mcp@2.0.0-beta.45`; drop "beta.45 exists".
- N2 (365): names come from the router path (no `operationId` anywhere), not the meta. They match the chat's names, as verified above.
- N3 (366, 393): "curated" already means the four writable entities; call the tool filter an allowlist.
- N4 (367–369): "the Confire account" means the user's; "older clients" has no criterion; "load the skills" is an instruction to the builder, not design.
- N5 (379): a write without a source *drops* the key's existing ✦ (CLAUDE.md); fix the wording and the informal tone.
- N6 (401–402): "`ai-persistence` if used" contradicts §9 line 461.
- N7 (458): `assistant_settings` now also has `b1AutoWrite` and `updatedAt`.
- N8 (485): `QUOTE_HEADER` refuses other keys (`QUOTE_NOT_SETTABLE`); it is not a filter.
- N9 (278, 312, 380): MCP configurations record no `via` and never count as "assisted configurations" in `ai_usage`. Say whether that is intended.
- N10: dev testing: Claude/ChatGPT cannot reach localhost. The `dev:pair` tunnel (or a cloudflared quick tunnel to :5173) is not mentioned.
- N11 (443, 489–491): repeated text and informal wording ("for free", "a bad document").

## Traceability

| Consolidated | Implementation readiness | Codebase details | Style |
|---|---|---|---|
| B1 | Blocker 1 | B1 | Nit 8 |
| B2 | Blocker 2 | B3 | Nit 12 |
| B3 | Blocker 3 | B2 | Nit 11 |
| B4 | Blocker 3 (part) | B4 | Blocker 1 |
| B5 | Blocker 4 | B2 (part), N6 | — |
| M1 | Major 5 | M1 | Major 3 |
| M2 | Major 6 | M10, N1 | Major 4, Major 6 |
| M3 | — | M3 | — |
| M4 | Major 7 | M4, N3, N4 | Major 5, Major 6 |
| M5 | — | M5 | — |
| M6 | Major 8 | N2 | — |
| M7 | Major 7 (part) | M11 | — |
| M8 | Major 9 | M6 | — |
| M9 | Major 10 | M8, M9 | Major 2 (note) |
| M10 | Nit 11 | M7 | Major 2 |
| M11 | — | — | Major 7 |
| Nits | Nits 12–14 | M2, N5, N7, N8 | Nits 9–17 |
