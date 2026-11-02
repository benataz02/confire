# Goldfish Annotated Review Report

Status: resolved (2026-11-02). Applied with the proposed fixes, except two that the user changed: B1 (SAP writes over MCP ask the user through MCP elicitation, hosted with `@tanstack/ai-mcp/server`) and B4 (the address is `https://mcp.<DOMAIN>`, and the workspace is Better Auth's consent reference carried in the token). M11 was declined.

**Target:** `docs/superpowers/specs/2026-10-24-ai-assistant-design.md` (lines 359–491)
Findings: `implementation_readiness_report.md` (round 1, three reviewers).

Most fixes land in one place: §4.10 is replaced by the text in **Appendix A** below, and the other sections
get the small edits listed per finding. Library facts behind the decisions were checked on 2026-11-02 against
the published tarballs (`@orpc/mcp@2.0.0-beta.45`, `@better-auth/mcp@1.7.7`, `@better-auth/oauth-provider@1.7.7`).

**Three proposals reverse a call recorded in §10 and need your decision (marked ⚑):** B1/M2 (no SAP write
over MCP), B4 (one connector address, no slug), B3 (no CIMD in phase 3).

## Prioritized Findings & AI Suggestions

### [B1] [`implementation-readiness`, `codebase-details`] - Severity: High ⚑
*   **Affected Scope:** [Lines 361-362](docs/superpowers/specs/2026-10-24-ai-assistant-design.md#L361-L362) (§4.10), b1-tools §5.5
*   **Discrepancy Description:** SAP writes over MCP are undecided, and `autoWrite` (`auto.ts:44`) already posts when the call has no thread. Confirm mode has no way to post.
*   **Rationale:** Over MCP, an external AI reading a client's drawing is the normal case, which is what the file exception guards against. A proposal nobody can post is dead.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** The smallest rule that keeps anti-goal line 88 ("nothing reaches SAP without a human click on a card the server built") is: **nothing posts over MCP**. `b1.write`/`b1.copy` stay out of the allowlist. `configs.createQuote` stays out too. `configs.quoteDraft` is in, and its MCP description tells the AI to hand the user the quote page's address (`/<slug>/configs/<id>/quote`), where they post as today, the same as the chat's "Review and post". There is no elicitation dependency, no proposal store and no approval page, and the `autoWrite` gap cannot be reached over MCP. Adding writes later is one allowlist change plus an approval design.
*   ***Proposed Edit:***
    *   Location: §4.10 → Appendix A "Tools" and "SAP writes"; §10 line 484–486; b1-tools §5.5
    *   Change: replace §10's createQuote bullet with "Over MCP nothing posts: `quoteDraft` answers the quote page's address, and the user posts there. `b1.write`/`b1.copy`/`createQuote` are added when an approval path over MCP exists." Rewrite b1-tools §5.5 to "phase 3 registers `b1.find/schema/read` only; the writes wait for an approval path (elicitation or a Confire approval page)".

### [B2] [`implementation-readiness`, `codebase-details`, `style`] - Severity: High
*   **Affected Scope:** [Lines 372-374](docs/superpowers/specs/2026-10-24-ai-assistant-design.md#L372-L374)
*   **Discrepancy Description:** The bearer-to-user seam is not designed; `requireSession` is private and reads cookies only.
*   **Rationale:** The builders cannot stay unchanged as written.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** `InitialContext.mcpUserId` is filled only by `mcp.ts`, after `requireMcpAuth` has verified the JWT. No request can fill it, the same as `assistantThreadId`. `userProcedure` uses a new `requireUser`: `mcpUserId` → a live read of the user row (deleted → `UNAUTHORIZED`), otherwise the session as today. `sessionProcedure` (`me`, the lobby, setup) keeps `requireSession`, so a bearer token never reaches the procedures that use `session`. `mcp.ts` sets `x-tenant` itself (Appendix A, B4), so `membershipOf` and every builder above it are unchanged. `/api/mcp` reads no cookie.
*   ***Proposed Edit:*** Appendix A "Who is calling".

### [B3] [`implementation-readiness`, `codebase-details`] - Severity: High ⚑ (CIMD)
*   **Affected Scope:** [Lines 367-369](docs/superpowers/specs/2026-10-24-ai-assistant-design.md#L367-L369)
*   **Discrepancy Description:** The OAuth setup is left to research: options, consent page, client registration, schema and migration, pins.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** `jwt()` + `mcp({ loginPage: "/login", consentPage: "/oauth/consent", resource })` in `auth.ts`. Client registration is **open dynamic registration** (`allowDynamicClientRegistration` + `allowUnauthenticatedClientRegistration`), which Claude and ChatGPT both use. Registered clients are public, PKCE-only, and every grant goes through consent. **No CIMD in phase 3**: it makes the server fetch a URL a client names, which is an outbound request Confire has avoided, and DCR covers both clients (ponytail note). Consent is a new staff SPA page, `/oauth/consent`, in the `AuthLayout` frame; `oauth` is reserved in `tenant.ts` and `host.ts`. `/login` forwards the signed `oauth_query` back to the authorize endpoint after sign-in. Pins: `@better-auth/mcp`/`oauth-provider` at the `better-auth` version (1.7.7), moved together. Schema: `bun run auth:generate`, then `db:generate` → `0011` (with the `mcp` column).
*   ***Proposed Edit:*** Appendix A "Sign-in"; §5 rows; §10 delete "Dynamic client registration is the fallback".

### [B4] [`style`, `implementation-readiness`, `codebase-details`] - Severity: High ⚑
*   **Affected Scope:** [Lines 370-372, 433, 465](docs/superpowers/specs/2026-10-24-ai-assistant-design.md#L370-L372)
*   **Discrepancy Description:** Is a token workspace-bound or user-bound? The doc contradicts itself.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** `mcp()` binds tokens to **one** `resource`, and MCP clients send the connector URL as that resource (RFC 8707). A per-workspace URL therefore needs one OAuth resource row per workspace. Meanwhile a user is staff of at most one workspace (`organizationLimit`, "there is no workspace picker"), so the slug in the path adds nothing the user row does not already say. Decision: **one connector address, `https://app.<DOMAIN>/api/mcp`**. The token says who; the workspace is that user's one staff membership (`oneMembership`, `sap.ts`), sent on as `x-tenant`, so `membershipOf` stays the boundary. The test becomes "a token whose user has no staff membership (a `portal_*` customer, or nobody's staff) is refused". `ponytail:` one resource for every workspace; per-workspace resources when a user can be staff of two.
*   ***Proposed Edit:*** Appendix A "The address"; §6 line 433; §9 line 465 → "One resource, `/api/mcp`; the workspace is the user's one staff membership"; §10 line 489 → same.

### [B5] [`implementation-readiness`, `codebase-details`] - Severity: High
*   **Affected Scope:** [Lines 366, 393](docs/superpowers/specs/2026-10-24-ai-assistant-design.md#L366)
*   **Discrepancy Description:** The mount and discovery are not specified; `/.well-known/*` would fall through to `index.html`.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** These are routes in `index.ts`'s `routes` (staff process), which `serve.ts` mounts before the SPA fallback. They are: `POST|GET|DELETE /api/mcp` under `requireMcpAuth` (its 401 carries the RFC 9728 `WWW-Authenticate`); `/.well-known/oauth-protected-resource/api/mcp` and `/.well-known/oauth-authorization-server` (+ `openid-configuration`) from the plugin's metadata helpers. The transport is Streamable HTTP, **stateless** (`sessionIdGenerator: undefined`, one `McpServer` per request), with a 2 MB `bodyLimit`. The origin guard stays: MCP clients are servers or CLIs with no foreign `Origin`, and the guard is also the DNS-rebinding defence the MCP spec asks for. Browser-hosted MCP clients are not supported. Caddy needs no change (the `app.` site proxies every path).
*   ***Proposed Edit:*** Appendix A "Mount".

### [M1] [all three] - Severity: Medium
*   **Affected Scope:** [Lines 364-366, 375](docs/superpowers/specs/2026-10-24-ai-assistant-design.md#L364-L375)
*   **Discrepancy Description:** "The same set as §4.5" is not a list of procedures; the chat's wrapper behaviours are lost on bare procedures.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** An exact allowlist (`filter` by path; anything else, `b1.post` and every admin procedure included, is absent): `configs.models/rows/get/create/calculate/queryPage/similar/select/quoteDraft`, `requests.rows`, `timeline.list`, `home.overview`, `b1.find/schema/read`. Per lost behaviour:
    *   `entities.rows` is **out**: `b1.find`/`b1.read` already cap their own handlers.
    *   Sources are asked for by an `mcp.tool({ description })` override, which only `@orpc/mcp` reads, so the chat and OpenAPI texts stay as they are (M6).
    *   `margin` and the 500-row `top` on Postgres lists are accepted: the AI acts as the user, who may set both on the page.
    *   `slimGet` is accepted (the user's tokens).
    *   `configs.create` records `via: "mcp"` when `mcpUserId` is set.
*   ***Proposed Edit:*** Appendix A "Tools".

### [M2] [`implementation-readiness`, `codebase-details`, `style`] - Severity: Medium ⚑
*   **Affected Scope:** [Lines 375-377, 484-486](docs/superpowers/specs/2026-10-24-ai-assistant-design.md#L375-L377)
*   **Discrepancy Description:** `createQuote` over MCP can post to another `CardCode`/`DocCurrency`; `destructiveHint` is not a human click.
*   ***AI Suggestion:*** PROPOSE FIX. Resolved by B1: `createQuote` is not registered over MCP.

### [M3] [`codebase-details`] - Severity: Medium
*   **Affected Scope:** b1-tools §5.5 line 212
*   **Discrepancy Description:** `b1.apply` is now `b1.post`; a deny-list would expose it.
*   ***AI Suggestion:*** PROPOSE FIX. The rename in §5.5, and "the filter is an allowlist" (M1).

### [M4] [all three] - Severity: Medium
*   **Affected Scope:** [Lines 319-324, 377, 397, 458, 482](docs/superpowers/specs/2026-10-24-ai-assistant-design.md#L377)
*   **Discrepancy Description:** The External AI switch is under-specified, and it has three names and a wrong count.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Column `assistant_settings.mcp boolean not null default false` (migration 0011). `assistant.settings`/`saveSettings` carry it. The Settings → Assistant tab gets a third switch, "External AI (MCP)", with where data goes, and the connector address with a copy button (en/es/eu). `mcp.ts` checks in this order: token (`requireMcpAuth`, 401), then staff membership (403), then the switch (403 JSON-RPC error `MCP_OFF`, "An admin turns on External AI in Settings → Assistant"), all before the MCP handshake. One name throughout: *External AI (MCP)*, column `mcp`. Fix "two switches" → "three switches" (lines 397, 482) and line 458 (the table now also has `b1AutoWrite`, `updatedAt`).
*   ***Proposed Edit:*** Appendix A "Switch"; lines 397, 458, 482.

### [M5] [`codebase-details`] - Severity: Medium
*   **Affected Scope:** [Lines 337-338, 370](docs/superpowers/specs/2026-10-24-ai-assistant-design.md#L337-L338)
*   **Discrepancy Description:** No UI shows the connector address.
*   ***AI Suggestion:*** PROPOSE FIX. The Settings → Assistant tab shows it (M4). The `ASSISTANT_LIMIT` message in the panel names the same address. One fixed URL, so it is one i18n string with the origin filled in.

### [M6] [`implementation-readiness`, `codebase-details`] - Severity: Medium
*   **Affected Scope:** [Lines 378-379](docs/superpowers/specs/2026-10-24-ai-assistant-design.md#L378-L379)
*   **Discrepancy Description:** The MCP-only description of `calculate` has no mechanism.
*   ***AI Suggestion:*** PROPOSE FIX. `mcp.tool({ description })` meta on `configs.calculate` and `configs.quoteDraft`. `@orpc/mcp` prefers it over the OpenAPI meta; the chat (`getOpenAPIMeta`) never reads it. Also fix "shows no ✦" → "drops that key's ✦" (style N5).

### [M7] [`implementation-readiness`, `codebase-details`] - Severity: Medium
*   **Affected Scope:** §4.10 (absent)
*   **Discrepancy Description:** No rate limit is applied to MCP.
*   ***AI Suggestion:*** PROPOSE FIX. `rateLimit(userId)` (`usage.ts`, 20 calls a minute, the same window as the chat's) is checked per `tools/call` in a registrar interceptor; the refusal is a tool error the AI reads.

### [M8] [`implementation-readiness`, `codebase-details`] - Severity: Medium
*   **Affected Scope:** [Lines 383-403](docs/superpowers/specs/2026-10-24-ai-assistant-design.md#L383-L403) (§5)
*   **Discrepancy Description:** The file list has one row for phase 3.
*   ***AI Suggestion:*** PROPOSE FIX. Replace the `mcp.ts` row with: `mcp.ts` (create: route, allowlist, switch, rate limit); `orpc/base.ts` (`mcpUserId`, `requireUser`); `auth.ts` (`jwt`, `mcp`); `index.ts` (mount); `tenant.ts` + `@confire/ui/host.ts` (`oauth` reserved); `schema/auth.ts` (generated) + `schema/assistant.ts` (`mcp`) + `drizzle/0011_*`; `routers/assistant.ts` (settings); `configs.ts` (`mcp.tool` meta, `via`); `apps/app` `routes/oauth.consent.tsx` + login's `oauth_query` hand-off; `AssistantSettings.tsx` + `admin.*.properties`; `apps/server/package.json`; CLAUDE.md, DEPLOY.md (no new env: the JWKS lives in the db).

### [M9] [`implementation-readiness`, `codebase-details`] - Severity: Medium
*   **Affected Scope:** [Lines 433, 436-443](docs/superpowers/specs/2026-10-24-ai-assistant-design.md#L433)
*   **Discrepancy Description:** Phase 3 has one test and is one undivided step.
*   ***AI Suggestion:*** PROPOSE FIX. §6 phase 3 tests (`mcp.test.ts`, with tokens minted by the test from the JWT plugin):
    *   no token → 401 with `WWW-Authenticate`;
    *   a token for another resource (audience) → 401;
    *   a `portal_*` user's token → 403;
    *   the switch off → 403 `MCP_OFF`;
    *   `tools/list` equals the allowlist (no `b1.post`/`b1.write`/`createQuote`/admin);
    *   a tool call reaches the user's own workspace and nothing else;
    *   `configs.create` over MCP records `via: "mcp"`.

    §7 phase 3 is split into: 3a seam + tests; 3b OAuth + consent + migration; 3c `mcp.ts` + switch + Settings; 3d docs.

### [M10] [all three] - Severity: Medium
*   **Affected Scope:** Lines 359, 393, 403, 433
*   **Discrepancy Description:** "Second phase"/"phase 2" vs "phase 3".
*   ***AI Suggestion:*** PROPOSE FIX. "phase 3" everywhere.

### [M11] [`style`] - Severity: Medium
*   **Affected Scope:** Lines 416–422 (§6 eval)
*   **Discrepancy Description:** The eval's measures are loose.
*   ***AI Suggestion:*** DECLINE (out of scope). This is built phase 1, outside the MCP plan the user asked to review. The eval stays as built; tighten it when the test set reaches its 30 cases.

### Nits
*   N1 (pin wording), N3 ("allowlist", not "curated"), N4 (vague words, the instruction to the builder), N5, N6 (`ai-persistence`), N7, N10 (dev: Claude Code CLI as the MCP client against `http://localhost:5173/api/mcp`, since loopback HTTP is allowed): **PROPOSE FIX**, folded into Appendix A and the edits above.
*   N2 (names from the path): **CONTEST** in part. The claim is right, and it is harmless: `@orpc/mcp` derives the path joined by `_` when there is no `operationId` (its docs, checked), the same names as `tools.ts`. Wording fixed in Appendix A.
*   N8 (`QUOTE_HEADER` "filter"): moot after B1 (the bullet goes).
*   N9 (`via`, `ai_usage`): PROPOSE FIX via M1 (`via: "mcp"`). MCP configurations do not count in `ai_usage` on purpose: Confire spends no tokens on them; they are counted by `created` events with `via: "mcp"` if pricing ever wants them.
*   N11 (repeated text, informal wording): PROPOSE FIX in §10 (lines 489–491).

---

## Appendix A: replacement for §4.10

```markdown
### 4.10 MCP (phase 3)

The user's own Claude or ChatGPT reaches Confire's procedures as MCP tools, signed in as the user. The
same builders run, so the user's AI sees and does what the user may, in the user's one workspace.
Confire spends no AI tokens on it: the user's AI reads the drawing, Confire supplies the parameters and
checks every edit.

- **The address:** one connector address for every workspace, `https://app.<DOMAIN>/api/mcp` (dev:
  `http://localhost:5173/api/mcp`, through Vite's proxy). The token says who; the workspace is that user's
  one staff membership (`oneMembership`: a user is staff of at most one workspace, `organizationLimit`), and
  `mcp.ts` sends its slug on as `x-tenant`, so `membershipOf` stays the tenant boundary. A user with no
  staff membership (a portal customer) is refused.
  `// ponytail: one OAuth resource for every workspace; per-workspace resources (/api/mcp/<slug>) when a
  user can be staff of two.`
- **Sign-in:** `jwt()` and `@better-auth/mcp`'s `mcp({ loginPage: "/login", consentPage: "/oauth/consent",
  resource: "<authUrl>/api/mcp" })` in `auth.ts`. Its packages are pinned to the `better-auth` version and move
  with it. Clients register by open dynamic client registration (`allowDynamicClientRegistration`,
  `allowUnauthenticatedClientRegistration`), which Claude and ChatGPT use. Every client is public (PKCE), and
  every grant is the user's click on the consent page: `/oauth/consent`, a staff SPA page in `AuthLayout` that
  names the client and what it reaches. `oauth` is a reserved slug. `/login` sends a signed-in user with an
  `oauth_query` back to the authorize endpoint. No CIMD: it makes the server fetch an address a client names
  (`// ponytail: add @better-auth/cimd when a client requires it`). The tables come from `auth:generate`, in
  migration 0011.
- **Who is calling:** `requireMcpAuth` verifies the bearer JWT against the JWKS (signature, issuer, the
  `/api/mcp` audience, expiry) and answers a missing or bad token with 401 and the RFC 9728
  `WWW-Authenticate`. Its `sub` becomes `InitialContext.mcpUserId`, which only `mcp.ts` fills (no request
  can, like `assistantThreadId`). `userProcedure` runs `requireUser`: `mcpUserId` → a live read of the user
  row; otherwise the cookie session as today. `sessionProcedure` keeps the cookie-only `requireSession`, so a
  token never reaches `me`, the lobby or setup. `/api/mcp` reads no cookie.
- **Switch:** *External AI (MCP)*, `assistant_settings.mcp` (off by default, migration 0011), in Settings →
  Assistant beside the other two. The tab names where data goes (Confire data to the user's own AI
  provider) and shows the connector address. Order of checks: token (401), staff membership (403), switch
  (403, `MCP_OFF`), all before the MCP handshake. `rateLimit` (20 calls a minute per user, shared with the
  chat) is checked per tool call.
- **Mount:** staff process only, in `index.ts`'s routes (before the SPA fallback): `/api/mcp` (Streamable
  HTTP, stateless: one `McpServer` per request; a 2 MB body limit) and the discovery documents
  `/.well-known/oauth-protected-resource/api/mcp`, `/.well-known/oauth-authorization-server` and
  `/.well-known/openid-configuration` from the plugin's metadata helpers. The origin guard in `serve.ts`
  stays: MCP clients are servers and CLIs, and it is the DNS-rebinding defence the MCP spec asks for. A
  browser-hosted MCP client is not supported.
- **Tools:** `@orpc/mcp` (`2.0.0-beta.45`, with the MCP SDK v2 `@modelcontextprotocol/server`) registers an
  **allowlist** by router path, its name the path joined by `_` (`configs_get`, the chat's names too):
  `configs.models/rows/get/create/calculate/queryPage/similar/select/quoteDraft`, `requests.rows`,
  `timeline.list`, `home.overview`, `b1.find/schema/read`. Everything else is absent, `b1.post` and every
  admin procedure included. These are the bare procedures, so what the chat's wrappers add is either in a
  handler already (the `b1` caps) or accepted: the AI acts as the user, who may set `margin` and page up to
  500 rows on the page too. `entities.rows` is left out (`b1.find`/`b1.read` cover SAP reads). A
  configuration created over MCP records `via: "mcp"`.
- **SAP writes:** none over MCP. `configs.quoteDraft`'s MCP description (`mcp.tool` meta, which only
  `@orpc/mcp` reads) tells the AI to give the user the quote page's address,
  `<authUrl>/<slug>/configs/<id>/quote`, where the user posts as today. `configs.createQuote`, `b1.write` and
  `b1.copy` are added when there is an approval path over MCP (elicitation, or an approval page for a
  proposal); until then auto mode does not arise over MCP.
- **Provenance:** `configs.calculate`'s MCP description asks the client to pass `sources`. Confire cannot
  enforce that on an external client: a value written without a source drops that key's ✦.
- **Dev:** Claude Code as the client, `claude mcp add --transport http confire http://localhost:5173/api/mcp`
  (OAuth over loopback HTTP is allowed in dev). Claude.ai and ChatGPT need the public address.
```
