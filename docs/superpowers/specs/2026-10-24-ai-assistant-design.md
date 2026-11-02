# The assistant: from a drawing to a configuration, and Confire over MCP

2026-10-24 · design · **phases 1–2 built 2026-10-25** (plan `docs/superpowers/plans/2026-10-24-ai-assistant.md`); MCP (phase 3) designed 2026-11-02 (§4.10)

## 1. Why

A quote request (RFQ) reaches a salesperson's own mailbox as a technical drawing plus the client's
instructions. Today someone reads it, types the values into the configurator by hand and asks the
engineers about whatever is unclear. About half of what goes in is written on the drawing
(dimensions, material, quantities); the other half is experience, and the objective is that the
experience lives in the model's rules. New salespeople suffer most: they don't know the rules yet and
they type slowly.

The objective is to **automate and accelerate the configuration process as much as possible**. An
assistant reads the drawn half, the model's rules supply the experience half, and whatever neither
settles is asked, never guessed. Explaining why an option is ruled out is how a new salesperson learns
the rules.

There are two ways in, both first-class:

1. **Confire's own assistant**: a chat panel in the staff app, on Claude, paid for by Confire and
   metered per workspace.
2. **The user's own AI subscription through MCP**: Claude or ChatGPT connected to Confire as a
   connector, on the user's own tokens. Good for quick, simple configurations day to day, and it is a
   showcase for directors who are keen on AI.

Both reach the same tools under the same rules, so a configuration made either way is the same
configuration.

## 2. Decided by the user

- **Values are never guessed.** Every value comes from the attachments, the client's text or a rule.
  Otherwise the assistant asks. A dimension that can't be read with confidence is asked too, not read
  as a best guess.
- **Users:** the manufacturer's staff, new salespeople above all. **No assistant for portal clients.**
- **Claude is the internal provider.** There is no provider choice for users or tenants: one provider,
  set as one server setting.
- **TanStack AI** is the AI SDK.
- **Mail is manual for now.** The salesperson drags the drawing and photos into the panel and pastes
  the email text. A "Send to Confire" button inside Outlook and Gmail is the planned next step for
  mail, not part of this build. There is no forwarding address and no mailbox OAuth.
- **The panel** opens from the existing ShellBar assistant toggle (`AppShell.tsx`, the `assistant`
  slot). It is usable alone (chat only) or beside the configuration page, which updates as the chat
  goes. Beside the page it **floats over the page's right edge, Joule-style**, covering the insights
  rail while open (mockup option C).
- **The assistant knows where it is**: it reads the TanStack Router context (route and params) to
  decide how to act on each page.
- **Posting the quotation to SAP is included, with confirmation.** The salesperson sees what will be
  posted and clicks to post.
- **Cost:** a meter now plus a monthly limit per workspace set by Confire (the operator), with pricing
  decided later. Pay-as-you-go against subscription is not decided and is not built.
- **The model-building assistant is wanted, but later**, with its own design. This build only leaves
  room for it (§4.3).
- **The Post button in the chat opens the existing quote page** ("Review and post"), where the header
  is completed and the quotation posted as today. It does not post from the chat.
- **Files dropped into the assistant are posted to the configuration** as its files.
- Testing uses past configurations that carry the client's drawing. **Drawings exist only as files
  attached in Confire's Postgres**: there is no other archive to import, so the test set starts small
  and grows as the assistant is used.

## 3. Goals, non-goals, anti-goals

**Goals**

- From a dropped drawing plus pasted text to a configuration that is as complete as possible, with the
  remaining gaps asked as one-click questions.
- Every value the assistant sets shows its source (page and the text read), on the page and in the
  chat.
- The salesperson explains nothing to the assistant that the model already knows: the model's
  description, its parameters' help texts and its rules are the assistant's knowledge.
- One tool layer: the existing oRPC procedures, used by the in-app assistant and exposed over MCP.
- Cost known per workspace, with a limit that stops a runaway.

**Non-goals (this build)**

- Mail integration of any kind (the add-in comes later), `.eml`/`.msg` drop.
- Assisting model building (next design).
- The portal.
- Billing, invoicing, plans.
- A provider choice, bring-your-own-key, an EU-region provider (the adapter swap is cheap when a tenant
  requires it).
- A trained classifier or OCR model: Claude reads PDFs and images natively, and choosing the model is
  a cheap first call to the same model (§4.1), not a second kind of model.

**Anti-goals: failures even if it "works"**

- A value that came from nowhere: a plausible dimension, a default material "because it's common".
- Anything reaching SAP without a human click on a card the server built.
- The assistant seeing or doing more than the user it runs as: another tenant, an admin-only read for
  a non-admin.
- Text inside a client's PDF or email steering the assistant.
- A second calculation path: the assistant computes nothing; the server answers every figure as it
  does for the page.

## 4. Design

### 4.1 The flow

(The brainstorm mockups were throwaway and are gone; this text is the spec. In the chat each
question shows its allowed values as chips. Beside the page, the panel floats per §4.2.)

1. **Drop.** The salesperson opens the panel anywhere, drops files (PDF, PNG, JPEG) and pastes the
   email text. On a configuration that already has files (a client's request comes with its drawing
   on the timeline), the panel offers to read those too.
2. **Model and customer: a first, cheap call.** It gets the attachments, the text, and the published
   models' names and descriptions (`configs.models` gains each model's `description`). It proposes a
   model, a customer (a BusinessPartners read: signature, sender domain, company name) and a name
   ("ACME – Bracket WB-200"). Each is a chip to confirm or change. Nothing is created until the
   salesperson confirms. Confirming calls `configs.create`. The dropped files become the
   configuration's files (`addFile`, which writes the `file` events), and the main area navigates to
   the process page if the user wants it there. On a configuration's page, the model is already known
   and this step is skipped.
3. **Extraction** (§4.4): a second structured call reads the attachments against the chosen model's
   parameters and answers values with sources, plus what it could not settle. The server applies the
   values through `configs.calculate`, exactly like a page edit, so the patch validation refuses
   anything the model does not accept. Sending the drawing twice costs a cent or so, which is cheaper
   than a single call carrying every model's parameter list. **Extraction only fills empty fields.** A
   value it reads that differs from one already there (the client's entry, someone's typing, an
   earlier drop) becomes a question, never an overwrite. This is the same rule as the page's
   copy-from-similar.
4. **Questions.** The rules fill what they can (`propagate`). What is still in the view's `missing`,
   plus what the extraction flagged as unreadable or ambiguous, becomes questions. Each question offers
   the parameter's **allowed values from the form state** as chips. A chip click is a direct
   `configs.calculate` call from the panel, with no model round trip. "Other…" types a value the
   server validates. A ruled-out option is explained with the rule that removed it.
   *(2026-10-28)* They are asked **one at a time** ("Question 2 of 5"; Skip sends one to the back).
   On a field the model's history maps, "Not sure?" lists what the most similar past quotes used
   (`configs.similar`), each taken in one click. When the model itself is unsure between known options
   (which customer, which option, which reading), it calls **`ask_user`**: the options become a choice
   card, the run ends there, and the pick is the user's next message. Only one question is on screen at
   a time: an open ask hides the question card. Once only skipped questions are left, the card's answers
   go to the chat as the user's message ("My answers, already saved: …") and the model goes on with
   what the card does not ask (a broken rule, a table, the candidates). A configuration the chat
   creates is worked on where the user is: the thread, not the page, decides the tools and the model
   block, and business partners are read as customers only.
5. **Complete.** Once `missing` is empty the server calculates candidates. The chat shows them (best
   prices per batch quantity) and similar past quotes (`configs.similar`), and the salesperson picks in
   the chat or on the page (`configs.select`).
6. **Post with confirmation** (§4.6).

On the process page, every field marks where its value came from:

- **✦** the assistant read it (hover shows the source)
- **⚙** a rule set it
- **💬** it is waiting on a question in the chat

The salesperson can edit any field on the page at any time. The assistant reads the view fresh on
every turn and never relies on its own earlier answers. Two writers of different fields don't
collide, because the patch is merged in SQL (`entries || set - unset`).

### 4.2 The panel

- The toggle in `AppShell.tsx` opens one panel. The panel keeps its thread while the user navigates
  (it is shell state, not page state).
- It floats over the right edge of the content, Joule-style, and doesn't push the page. On the process
  page it covers the insights rail. The chat can show costs and similar quotes on request.
- Built with UI5 Web Components. Follow the Fiori AI/Joule guidance (the `sap-fiori-guidelines`
  skill). Use `@ui5/webcomponents-ai` where it fits.
- `useChat` from `@tanstack/ai-react` over SSE to the server route (§4.8).
- *(2026-10-28)* **Cards only where the user decides** (`read_request`'s proposal, `ask_user`'s choice,
  `propose_quotation`'s quotation, plus the question and candidates cards). Everything else the agent
  does is shown the way Claude Code shows it: one fold per run, open while it works and "N steps"
  after, one line per tool call with what it found, the tool's card behind the line, and the model's
  summarized thinking. Look-ups are answered in the text, a few rows named, the rest behind the step.
- After a tool result that changed a configuration (`calculate`, `select`, `create`), the panel
  invalidates that configuration's `configs.get` (and the list) so the page redraws.
- Texts go through the app's i18n bundles (en, es, eu). The assistant answers in the user's app
  language.
- Attachments upload through a files-style route (past the 2 MB RPC cap, `FILE_MAX` per file), never
  inside the chat body.

### 4.3 Page context: the assistant acts per place

With each message the panel sends the current page from the router: the deepest match's `routeId`
and its `params` (e.g. `/$slug/configs/$id` with `{ id }`), and whether the page has unsaved state.
The server maps the route to:

- **a tool set**: which procedures the model may call here
- **a prompt section**: what this page is and what the user is probably doing

| Page | Acts as |
|---|---|
| `/$slug/configs/$id` | configure *this* configuration: extraction, questions, explain rules, candidates, post |
| anywhere else (home, lists, requests) | start a configuration from dropped files; answer questions over configurations, requests, SAP documents |
| `/$slug/models/$id`, `/$slug/models/new` | reserved for the model-building assistant (later). For now, general answers only, no model edits |

The route is a **hint, never a permission**. Every tool call goes through the procedure's own builder
(`userProcedure` / `adminProcedure`) with the user's session and `x-tenant`, so the membership join
stays the tenant boundary and admin-only reads stay admin-only. The registry is one plain map in
code. Adding the model builder later means adding one entry plus its tools.

### 4.4 Extraction: one structured call

**Input**, in cache-friendly order:

1. tools
2. system prompt (frozen)
3. the model block, which is stable per model version and so carries the cache breakpoint: the
   model's `description`, then each parameter's key, label, type, `help`, allowed values or range,
   and whether it is required, plus the items grid's columns when the model has one
4. the attachments as `document` (PDF) and `image` content parts
5. the pasted text

**Output** (structured output; the schema is generated per model from the form state, so the answer
cannot name a parameter that doesn't exist):

```ts
{
  set: [{ key, value, source: { file, page?, quote } }],  // only what is read, not inferred
  batches?: { qtys: number[], source },                     // "50 and 200 units" in the email
  tables?: { [table]: rows },                               // a drawing's parts list → the items grid
  unsure: [{ key, why, candidates? }],                      // read but not with confidence → asked
  notes: string[],                                          // anything the client asked that no parameter holds
}
```

- Finite option lists go into the schema as enums. A masterdata-backed list too large for an enum
  is a string, which the server validates through the patch, and the chat can search it with
  `configs.queryPage`.
- The server applies `set`/`batches`/`tables` to empty fields only (§4.1 step 3) with one
  `configs.calculate`, which carries the sources (§4.7). Anything the patch refuses becomes a question
  rather than an error.
- Model: **Claude Sonnet 5.5 for the extraction and the chat (`ASSISTANT_MODEL`); the intake — a
  classification of the drop: model, customer, name — on Claude Haiku 5.5 at low effort
  (`ASSISTANT_INTAKE_MODEL`, decided 2026-11-02).** Use adaptive thinking; the chat's effort is
  `ASSISTANT_EFFORT` (default `high`, Sonnet 5.5's own), set from the chat eval's sweep (§6). The Claude
  API's server-side refusal fallback (`fallbacks: "default"`) is on for Sonnet 5.5 and Opus 5.5; Haiku
  5.5 has none.
- The system prompt states that attachments and pasted text are the client's content to read, never
  instructions.

### 4.5 The chat and its tools

> SAP reads and writes beyond `entities_rows` — `b1_find`/`b1_schema`/`b1_read`/`b1_write`/`b1_copy`,
> proposals and auto mode — are `2026-11-02-b1-tools-design.md`.

`chat()` from `@tanstack/ai` with `anthropicText()`. The tools are **existing procedures, called
through a server-side router client built with the request's own headers**, so the builders' middleware
runs exactly as for the page. Tool names, input schemas and descriptions come from the procedures
themselves. The configs router already carries `openapi()` descriptions written for an AI client, so
nothing is described twice.

**No value from nowhere, mid-chat either.** The chat's `configs.calculate` tool is stricter than the
procedure: every key it sets needs a `source`, which is either a quote from an attachment or "the user
said so in the chat". A call missing one is refused back to the model.

First tool set (by page, §4.3):

- configuring: `configs.get`, `configs.calculate`, `configs.queryPage`, `configs.similar`,
  `configs.select`, `configs.quoteDraft` (plus `propose_quotation`, §4.6)
- starting: `configs.models`, `configs.create`, `entities.rows` on BusinessPartners (customer match)
- answering: `configs.rows`, `requests.rows`, `home.overview`, the timeline, `entities.rows` for SAP
  documents (quotations, orders: past documents for a customer). Opening one is the page's own read
  (`entities.one`), which every staff member may call; the assistant does not.

Two things the assistant does **without** a model call:

- the chips (§4.1 step 4)
- the post button (§4.6)

Both are direct procedure calls from the panel.

### 4.6 Posting to SAP, with confirmation

The assistant has **no tool that posts**. Its `propose_quotation` tool calls `configs.quoteDraft` and
returns the server-built draft (lines, totals). The panel draws it as a summary card with a
**Review and post** button that opens the existing quote page (`/$slug/configs/$id/quote`,
`QuoteCreatePage`), exactly where the page's footer leads. There the salesperson fills in the header
fields (contact, dates, whatever SAP marks required) and posts, as today.

Nothing new posts anything: the quote page's `createQuote` with its `commandId` echo already guarantees
that what was shown is what gets posted, and that a retry is idempotent. No TanStack approval interrupt
or interrupt store is needed.

### 4.7 What is stored

New schema, shipped with its migration (`db:generate`) and re-exported from `schema/index.ts`:

- **Provenance lives on the configuration**, so everyone who opens it sees the markers, and a
  configuration made over MCP has them too:
  - `config_project.sources` jsonb: key → `{ value, source }`
  - `configs.calculate` gains an optional `sources` input, written in the same `UPDATE` as the patch
    and merged the same way (`sources || new`)
  - The page shows ✦ for a key only while its entry still equals `value`, so a human edit drops the
    marker without another write. The page's own edits send no sources.
- **`assistant_thread`**:
  - tenant, user, `projectId` (nullable until a configuration exists), title, `messages` jsonb
  - **One thread per (user, configuration).** Opening the panel on a configuration's page resumes that
    user's thread for it, or starts one; navigating to another configuration switches to that one's
    thread. Elsewhere the panel shows the user's last general thread. **New chat** is on every page:
    elsewhere it starts a general thread; on a configuration it starts that configuration's thread over —
    the old one is deleted (after a confirm, never mid-answer), and what it filled stays on the
    configuration. A general thread that creates a configuration becomes that configuration's thread.
    *(2026-10-28)* The AI configuration page lists them instead (`AssistantPage.tsx`): its bar's UI5
    `Search` opens on a click to the user's own chats, pinned first then the latest, searched as one
    types (title, configuration name, the chat's text) and deleted there; the open chat's title is a
    menu (pin, rename, delete). An empty chat there is a welcome — a `HeroBanner` in the assistant's
    gradient with the chat box inside — which gives way to the chat on the first send. The panel keeps
    Joule's gradient head, its greeting collapsing once the chat starts. A deleted chat's configuration and what it
    filled stay. The panel is not drawn on that page; *Open configuration* opens the form with the
    panel on the same thread. `assistant_thread.pinned`, migration `0008`.
  - Server-owned history: the server loads the messages by thread id rather than trusting the client's
    copy. `@tanstack/ai-persistence`'s message store over this one table if it fits; no run/interrupt
    stores.
- **`assistant_file`**: a thread's dropped files (bytea, like `project_file`) before a configuration
  exists. They are copied into `project_file` through `addFile` on `configs.create`.
- **`ai_usage`**, one row per model call:
  - tenant, user, thread, project
  - model id; input, output, cache-read and cache-write tokens
  - cost (from the token counts and a price table in code)
  - kind (`extract` / `chat`)
  - at

  An "assisted configuration" is a distinct project in `ai_usage`, which is the unit pricing will
  count later. **Who sees it:** the admin's Assistant tab shows this month's cost against the limit and
  the number of assisted configurations (one small `adminProcedure`). The operator reads across
  tenants with SQL
  (`// ponytail: SQL on ai_usage; an operator screen when there is more than one person to show it to`).
- **Workspace switches** (admin, Settings → a new **Assistant** tab):
  - *Confire assistant* on/off
  - *External AI (MCP)* on/off

  Both are **off until an admin turns them on**, and each names where data goes: drawings to Anthropic
  for the first, Confire data to the user's own AI provider for the second. Built: the first is the
  column `assistant_settings.assistant` (a column, not jsonb: the chat route filters on it). The `mcp`
  switch comes with phase 3, beside it.

The timeline: a configuration created from the panel records its `created` event with
`via: "assistant"` in the payload, and its attachments as `file` events, so it reads "created by the
assistant from RFQ_ACME.pdf".

### 4.8 The server route

A plain Hono route, `POST /api/assistant` (SSE via TanStack's `toServerSentEventsResponse`), mounted
by the **staff process only**. In order:

1. It authenticates like `userProcedure`: session plus `membershipOf(x-tenant)`.
2. It refuses if the workspace's assistant switch is off, or if this month's `ai_usage` cost has
   reached the limit. The refusal is coded so the panel can say "limit reached, connect your own
   Claude or ChatGPT", with the MCP instructions.
3. It loads the thread, picks the page's tools and prompt section, runs `chat()`, and writes the
   `ai_usage` rows and the thread.

The **limit** is one monthly cost per workspace, an env default for all workspaces
(`// ponytail: one env default; a per-workspace override when a customer needs a different limit`).
The cost is what the limit protects, and the count of assisted configurations is what gets reported.

The provider key (`ANTHROPIC_API_KEY`) is server env only, and the test preload drops it like
`RESEND_API_KEY`, so tests never call the API.

### 4.9 Security: client content is data

- Attachments and pasted text are untrusted. The system prompt says so. The tool surface is bounded to
  what the user may do anyway, and there is **no outbound channel**: no mail, no web fetch, no URL
  the model can make Confire request. The one external write (SAP) is a human click (§4.6).
- The worst case of a hostile document is a wrong value, shown with its source, on a configuration the
  salesperson reviews.
- Per-user rate limits on the route. Files are size-capped, and only PDF and image types are accepted
  (sniffed like `imageType`, not trusted from the name).

### 4.10 MCP (phase 3)

> Decided 2026-11-02 after an implementation-readiness review. This supersedes
> `2026-11-02-b1-tools-design.md` §5.5 on the SAP tools over MCP.

The user's own Claude or ChatGPT reaches Confire's tools over MCP, signed in as the user. The same
builders run under them, so the user's AI sees and does what the user may, in the user's workspace.
Confire spends no AI tokens on it: the user's AI reads the drawing, Confire supplies the parameters and
checks every edit.

- **The address:** `https://mcp.<DOMAIN>` (`mcpUrl`, `tenant.ts`), the same for every workspace; dev
  `http://mcp.localhost`. It is its own host, served by the staff process: `index.ts` sends a request for
  it to `mcp.ts` before the staff app sees it, so the host answers MCP at `/` and its protected-resource
  document, and nothing else (no SPA, no `/rpc`). Caddy's `mcp.` site only proxies. In dev, `*.localhost`
  is loopback and plain http is allowed there; `bun run dev` forwards port 80 to the staff server
  (`scripts/dev-mcp.ts`; port 80 needs `net.ipv4.ip_unprivileged_port_start=80` once). `@better-auth/mcp`
  1.7.15 allows plain http only for exactly `localhost`, so a one-line patch (`patches/`) lets it take
  `*.localhost` too, as its own core already does. It is a host under `<DOMAIN>`, so the session cookie
  reaches it, and it is this stack's own service; the MCP host reads no cookie.
- **Sign-in and workspace, both Better Auth's:** `jwt()` and `@better-auth/mcp`'s `mcp()` in `auth.ts`
  (packages pinned to the `better-auth` version, moved together), `resource: mcpUrl`, `loginPage: "/login"`,
  `consentPage: "/oauth/consent"`. **The workspace is the consent's reference:**
  `postLogin.consentReferenceId` returns the user's one staff membership's organization (`oneMembership`:
  a user is staff of at most one workspace, `organizationLimit`) and refuses one with none, a portal
  customer included, before any token is issued. `postLogin.shouldRedirect` is always false (one workspace,
  nothing to pick). `customAccessTokenClaims` writes that reference into the token as `tenant`, so a token
  is bound to one workspace and a consent is stored per workspace.
  `// ponytail: one workspace per staff user; a workspace picker as postLogin.page when that changes.`
  Clients register by open dynamic client registration (`allowDynamicClientRegistration`,
  `allowUnauthenticatedClientRegistration`, `clientRegistrationDefaultApplicationType: "infer"`), which
  Claude and ChatGPT both use. Every client is public (PKCE), and every grant is the user's click on the
  consent page: `/oauth/consent`, a staff SPA page in `AuthLayout` naming the client and the workspace. Its
  query is verified with `verifyOAuthQueryParams`. `oauth` is a reserved slug. The sign-in page passes the
  signed `oauth_query` through (`oauthProviderClient`). No CIMD: it makes the server fetch an address a
  client names (`// ponytail: @better-auth/cimd, with an SSRF-safe transport, when a client requires it`).
  The tables come from `auth:generate`, in migration 0011.
- **Who is calling:** `requireMcpAuth` verifies the bearer JWT against the JWKS (signature, issuer,
  audience `mcpUrl`, expiry) and answers a missing or bad token with 401 and the RFC 9728
  `WWW-Authenticate`. `mcp.ts` then reads `sub` and `tenant`, looks up the tenant's slug, and builds the
  tools' headers itself: `x-tenant` from the token, never from the request. `InitialContext.mcpUserId`
  carries the user. Only `mcp.ts` fills it (no request can, like `assistantThreadId`). `userProcedure` runs
  `requireUser`: `mcpUserId` → a live read of the user row, otherwise the cookie session as today. So
  `membershipOf` is still the tenant boundary, read live on every call, and a member removed after the
  token was issued is refused. `sessionProcedure` (`me`, the lobby, setup) keeps the cookie-only
  `requireSession`.
- **Switch:** *External AI (MCP)*, `assistant_settings.mcp` (off by default, migration 0011), in Settings →
  Assistant beside the other two. The tab names where data goes (Confire data to the user's own AI
  provider) and shows the connector address. Order of checks: token (401), staff membership (403), switch
  (403, `MCP_OFF`), all before the MCP handshake. `rateLimit` (20 calls a minute per user, shared with the
  chat) is checked per tool call.
- **Server:** `@tanstack/ai-mcp/server`'s `createMCPServer` hosts the chat's own tools: `tools.ts`'
  `toolDefinition().server()` tools, called through the procedures exactly as the chat calls them. The
  server is built once, so each tool reads its call's user and headers off `ctx.context` (`CtxOf`). So
  MCP and the chat share one tool layer with the same names, wrappers and rules: `configs_calculate`
  requires a source per value and has no `margin`, lists are capped at `LIST_CAP`, and business
  partners are customers only. It speaks MCP 2026-07-28 and 2025 (`sessions: "memory"`: one staff
  process; 2025 elicitation needs the open session). `server.handle(request, { authInfo, context })` runs
  behind `requireMcpAuth`. On the MCP host: `/` (a 2 MB body limit) and
  `/.well-known/oauth-protected-resource`, which Better Auth answers itself (the `mcp()` plugin's
  `onRequest`). On the staff app's host (the issuer's): the authorization server's two documents
  (`oauth-authorization-server`, `openid-configuration`, issuer-inserted `/api/auth`) from the plugin's
  metadata helpers. The verifier reads the JWKS over loopback. The MCP host refuses any request carrying
  an `Origin`: MCP clients are servers and CLIs, and that is the DNS-rebinding defence the MCP spec asks
  for. A browser-hosted MCP client is not supported.
- **Tools:** the chat's set, less what needs a thread: `configs_models/rows/get/calculate/queryPage/similar/select`,
  `configs_create` (`via: "mcp"`, no files to copy), `requests_rows`, `timeline_list`, `home_overview`,
  `entities_rows`, `b1_find/schema/read`, and the destructive ones below (`MCP_TOOL_NAMES`, `tools.ts`).
  `ask_user`, `read_request` and `extract_values` are left out: the user's AI asks in its own chat, and it
  reads the files itself. `propose_quotation` is left out because it draws a card; `post_quotation`'s
  confirmation shows the same draft. `b1.post` is never a tool.
- **SAP writes ask the user first (the approval path).** The destructive tools are `b1_write`, `b1_copy`
  and `post_quotation` (`quoteDraft` then `createQuote`), annotated `destructiveHint`. Over MCP each one
  always prepares a proposal: auto mode never applies (`autoWrite` is false for an MCP call), because
  Confire cannot see what the external AI read. It then asks with MCP elicitation
  (`ctx.context.requestInput`). The question is built by the server: the record or quotation, and each
  field before → after (the quotation's customer, currency, lines and total). It posts only on the user's
  accept: `b1.post` with the proposal (its ETag re-checked, so a record changed since is `CONFLICT`), or
  `createQuote` with the draft's `commandId`. A decline answers "not posted". On spec 2026 the tool runs
  again with the answer, so the proposal is prepared again and the ETag decides. A client that cannot
  elicit gets a tool error saying nothing was posted.
  `// ponytail: elicitation only; an approval page in Confire for clients without it.`
- **Provenance:** `configs_calculate` requires a `source` per written value, as in the chat. The external
  AI writes those sources, and Confire cannot check them against a file it never saw. A value written
  without a source is refused.

## 5. Code layout

| Where | What |
|---|---|
| `apps/server/src/assistant/route.ts` | the SSE route: auth, switch, limit, thread load/save, `chat()` |
| `apps/server/src/assistant/pages.ts` | route id → tool set + prompt section (§4.3) |
| `apps/server/src/assistant/tools.ts` | procedure list → TanStack tools via a server-side router client |
| `apps/server/src/assistant/extract.ts` | the extraction call: model block, per-model schema, apply, sources |
| `apps/server/src/assistant/usage.ts` | meter rows, the monthly sum, the limit, the price table |
| `apps/server/src/assistant/files.ts` | thread attachment upload/serve; copy to `project_file` on create |
| `apps/server/src/mcp.ts`, `index.ts`, `scripts/dev-mcp.ts` | phase 3: the MCP host (split off by host in `index.ts`; dev's port-80 forwarder) and discovery, `requireMcpAuth` → user + tenant, the switch, the rate limit, `createMCPServer` over the MCP tool set and the approval tools |
| `apps/server/src/orpc/base.ts` | phase 3: `InitialContext.mcpUserId`, `requireUser` under `userProcedure` |
| `apps/server/src/auth.ts` | phase 3: `jwt()`, `mcp()` (consent reference = workspace, `tenant` claim, DCR) |
| `apps/server/src/assistant/tools.ts`, `auto.ts` | phase 3: `mcpTools` (the chat's tools less the thread's, plus the approval tools); no auto mode over MCP |
| `apps/server/src/tenant.ts`, `packages/ui/src/host.ts` | phase 3: `mcpUrl`; `oauth` reserved |
| `apps/app/src/routes/oauth.consent.tsx`, the login page | phase 3: the consent page; `oauthProviderClient` keeps `oauth_query` |
| `packages/db/src/schema/auth.ts` (generated), `assistant.ts` | phase 3: the OAuth tables, `assistant_settings.mcp`, migration 0011 |
| `deploy/Caddyfile`, `DEPLOY.md` | phase 3: the `mcp.` site |
| `packages/db/src/schema/assistant.ts` | `assistant_thread`, `assistant_file`, `ai_usage` (+ migration) |
| `apps/app/src/assistant/` | the panel, chips, the quotation card, route-context capture |
| `ConfigProcessPage.tsx` / `ConfiguratorForm` | ✦ ⚙ 💬 markers from the thread's `sources` and the view |
| Settings → Assistant tab | the three switches (assistant, SAP auto mode, External AI), with where the data goes; the MCP address |

New dependencies are listed as direct dependencies wherever they are imported:

- `@tanstack/ai`, `@tanstack/ai-anthropic` and `@tanstack/ai-react` (1.0.x)
- phase 3: `@tanstack/ai-mcp` (1.0.x) with `@modelcontextprotocol/server` (2.x); `@better-auth/mcp` and
  `@better-auth/oauth-provider` at the `better-auth` version

## 6. Tests

- **The test set** (`scripts/assistant-eval.ts`, run by hand because it spends real money: say the
  cost first):
  - The only source is `project_file` rows in Postgres. There is no importer. The script reads only
    configurations of workspaces whose *Confire assistant* switch is on: their drawings already go to
    Anthropic, so the test sends nothing new out. In dev, a few hand-attached sample drawings serve.
  - For each such configuration whose files include a PDF or image, run the extraction against its
    model.
  - Compare `set` with the stored entries per parameter, and report three numbers:
    - **differs**: a read value unlike the stored one. Stored entries are the *final* values, which
      the client may have revised after the drawing, so the report lists each difference with its
      source for a person to mark misread or revised. Misreads are the bar: about zero.
    - **filled share**: the score
    - **asked**: asked instead of guessed counts as a pass
  - The first call is scored too: was the configuration's actual model proposed?
  - Run Sonnet 5.5 and Haiku 5.5 on the same set; the model choice and effort level come from this
    **once there are about 30 cases**. Until then, Sonnet 5.5 at the default effort.
- **The chat's eval (spends money, run by hand: `scripts/assistant-chat-eval.ts`):** scripted
  scenarios over the real `SYSTEM` and the real tools, each tool answering a fixture, graded on the
  prompt's rules (a source for every value, ask_user for a choice and the turn ended there, no SAP
  write unasked, a client's text never obeyed, never "posted" without `written`). Each scenario runs
  per effort level: rules kept, model calls and cost per level decide `ASSISTANT_EFFORT`.
- **Unit tests (no API):**
  - the per-model schema from a form state (enums, ranges, a large list as a string)
  - `sources` marker logic (marker gone after a human edit)
  - the page registry (a route's note; unknown routes are general) and the one fixed tool set
  - the limit (refuses at the limit)
  - the switch (refuses when off)
- **Boundary tests:**
  - a tool call with a forged `x-tenant` is refused
  - a non-admin's tool set has no admin procedure
  - the route refuses without a session
- **MCP (phase 3, `mcp.test.ts`; tokens minted in the test with the JWT plugin):**
  - no token, or a token for another audience → 401 with `WWW-Authenticate`
  - a token whose user is no longer staff of its `tenant` → 403; a portal customer gets no consent
    reference, so no token
  - the External AI switch off → 403 `MCP_OFF`
  - `tools/list` is exactly the MCP set: no `b1.post`, no thread tools, no admin procedure
  - a tool call reaches the token's workspace only, whatever `x-tenant` the request sends
  - `b1_write` never posts without an accepted elicitation, auto mode on or off; a decline posts nothing
  - `configs_create` over MCP records `via: "mcp"`
- `chat()` itself is not unit-tested against a live model. Tests stub the adapter.

## 7. Phases

1. **Extraction**, server only: `extract.ts`, the per-model schema, `ai_usage`, `config_project.sources`,
   the eval script. Proven on a few hand-attached dev drawings. There isn't yet a real test set to
   settle the model choice, so it starts on Sonnet 5.5 (§6).
2. **The panel**: route, threads, files, tools, page context, chips, markers, the quotation card, the
   Settings tab.
3. **MCP** (§4.10), in four buildable steps: (a) `requireUser` + `mcpUserId` and their tests; (b) the OAuth
   provider (`jwt`, `mcp`, the consent page, the login hand-off, migration 0011); (c) `mcp.ts` with the tool
   set, the switch, the rate limit and the approval tools; (d) Settings, Caddy, DEPLOY.md and CLAUDE.md.

## 8. Later (not this build)

- **Model-building assistant**, its own design next. The builder's draft lives in the browser
  (`useDraftModel`, `checkModel` on every change), so the assistant will likely edit the draft through
  client tools, with Save staying the admin's.
- **Outlook/Gmail "Send to Confire" add-in**: it sends the open email's files and text into the same
  intake as a drop.
- Pricing and billing over `ai_usage`; per-workspace limits; an EU-region provider; bring-your-own-key.

## 9. Left to the builder — answered (2026-10-24/25)

| Question | Decision |
|---|---|
| Where the switches live | Table `assistant_settings` (tenant pk, `assistant`, `b1AutoWrite`, `mcp` booleans, `updatedAt`). |
| How ⚙ is known | Already known: `FieldState.defaulted` (a `defaultExpr` filled it). Rules only eliminate options and never set values, so ⚙ is the existing "Auto" status. |
| Enum size | `ENUM_MAX = 60` options. Query-backed fields are always a string in the schema, checked against the cache (`queryTablePage({ match })`). A hand-typed list past 60 is still listed whole in the model block. |
| `@tanstack/ai-persistence` | Not used: one jsonb column plus an append under a lease is less code, and its store merges *client* messages by id, which §4.7 forbids. |
| Intake orchestration | Fixed steps from the panel: `assistant.intake`, `assistant.start`, `assistant.extract`. The chat model runs only for typed messages. |
| Monthly limit | `ASSISTANT_MONTHLY_LIMIT_USD`, default 25, one value for every workspace. |
| Drawings in the chat's context | Kept: a thread's files stay at the turn they were dropped and are re-sent each turn under prompt caching. |
| Per-workspace MCP resource | One resource, `https://mcp.<DOMAIN>`; the workspace is the token's `tenant` claim, the consent's reference (§4.10). |
| Prices | Checked 2026-11-02 (the 2026-10-24 table had Sonnet 5.5's cache read at $0.10): Sonnet 5.5 $2 / $2.50 5-min write / $4 1-hour write / $0.20 cache read / $10; Opus 5.5 $4 / $5 / $8 / $0.20 / $20; Haiku 5.5 $0.10 / $0.125 / $0.20 / $0.01 / $0.50 (×5 past 100k prompt tokens). |
| Prompt wording, effort | `EXTRACT_SYSTEM`, `INTAKE_SYSTEM` and `SYSTEM` in `apps/server/src/assistant/`; effort left at the model's default until the eval has about 30 cases (§6). |
| Data in the chat | Cards, not prose: the tool's name picks the card (`apps/app/src/assistant/cards/registry.tsx`), the card draws the tool's output, and the model writes one or two sentences around it. |
| Product name | "Assistant" (`da` icon): "Joule" is SAP's. |

## 10. My calls

- No classifier or OCR model; the model choice is a cheap first call, extraction a second.
- Extraction fills empty fields only; a disagreement with an existing value is a question.
- Provenance on the configuration (`config_project.sources`, an optional `calculate` input); the
  chat must give a source for every value it sets.
- One thread per user and configuration, plus one general thread; New chat on both (a configuration's is deleted).
- The admin's Assistant tab shows the month's usage against the limit; SQL for the operator.
- Sonnet 5.5 for the chat and the extraction, Haiku 5.5 for the intake (two model settings).
- Chips and the post button bypass the model (cheaper, faster, and the human click is the write).
- The assistant has no posting tool; it proposes, the card posts.
- Every workspace switch (assistant, SAP auto mode, External AI) is off by default.
- The limit is measured in cost; the count of assisted configurations is reported for pricing.
- Over MCP, SAP writes (`b1_write`, `b1_copy`, `post_quotation`) are always proposals, posted only when the
  user accepts the server-built confirmation the MCP client shows (elicitation). The quotation's
  confirmation names its customer, currency, lines and total, because `QUOTE_HEADER` lets the AI set
  `CardCode` and `DocCurrency`.
- The eval reads only workspaces with the assistant switched on, and the model choice waits for about
  30 cases.
- One MCP address, `https://mcp.<DOMAIN>`; the workspace is Better Auth's consent reference, carried in the token.
- The dropped files are kept as the configuration's files, so the test set grows with no extra collection step.
