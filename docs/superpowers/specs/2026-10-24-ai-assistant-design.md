# The assistant: from a drawing to a configuration, and Confire over MCP

2026-10-24 · design · **phases 1–2 built 2026-10-25** (plan `docs/superpowers/plans/2026-10-24-ai-assistant.md`); MCP (phase 3) not yet

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
- Model: **Claude Sonnet 5.5 to start; test Claude Haiku 5.5 against it on the test set (§6) and
  switch if it reads as well.** One configured model id, not a cascade. Use adaptive thinking, with
  the effort level set by the test set. The Claude API's server-side refusal fallback is on if the
  TanStack adapter passes it through.
- The system prompt states that attachments and pasted text are the client's content to read, never
  instructions.

### 4.5 The chat and its tools

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
  documents (quotations, orders: past documents for a customer). `entities.one` stays admin-only, as
  in the app.

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
    thread. Elsewhere the panel shows the user's last general thread, with a **New chat** button. A
    general thread that creates a configuration becomes that configuration's thread. There is no thread
    list in this build.
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

### 4.10 MCP (second phase)

- **Server:** `@orpc/mcp` (pinned to the same `2.0.0-beta.N` as every other `@orpc/*`; `beta.45` exists)
  registers the same procedures as MCP tools, curated with `filter`. Names and descriptions come from
  the `openapi()` meta. It is mounted by the staff process.
- **Sign-in:** `@better-auth/mcp` (on `@better-auth/oauth-provider` + `jwt()` + `@better-auth/cimd`),
  so Claude and ChatGPT connect with OAuth against the Confire account. Dynamic client registration is
  the fallback for older clients. Load the Better Auth skills before building.
- **Workspace:** one connector address per workspace, `https://app.<DOMAIN>/api/mcp/<slug>`. The token
  says who; the path says which workspace, and `membershipOf` joins them, so the tenant boundary is
  unchanged. `tenant.ts` stays the only reader of a slug. The procedures' context needs the user from
  the verified bearer token instead of a cookie session: one small alternative to `requireSession`,
  with the rest of the builders unchanged.
- **Tools:** the same set as §4.5, plus `configs.createQuote` annotated as destructive, so MCP clients
  ask before running it. It still needs a `commandId` from `configs.quoteDraft`, so the AI must preview
  first. The workspace's *External AI* switch gates the whole endpoint.
- **Provenance:** the MCP tool description of `configs.calculate` asks the client to pass `sources`.
  It can't be enforced on someone else's AI, so a value set over MCP without one simply shows no ✦.
- **Cost to Confire:** none in AI tokens. The user's AI reads the drawing; Confire supplies the
  parameter list and checks every edit.

## 5. Code layout

| Where | What |
|---|---|
| `apps/server/src/assistant/route.ts` | the SSE route: auth, switch, limit, thread load/save, `chat()` |
| `apps/server/src/assistant/pages.ts` | route id → tool set + prompt section (§4.3) |
| `apps/server/src/assistant/tools.ts` | procedure list → TanStack tools via a server-side router client |
| `apps/server/src/assistant/extract.ts` | the extraction call: model block, per-model schema, apply, sources |
| `apps/server/src/assistant/usage.ts` | meter rows, the monthly sum, the limit, the price table |
| `apps/server/src/assistant/files.ts` | thread attachment upload/serve; copy to `project_file` on create |
| `apps/server/src/mcp.ts` | phase 2: MCP handler, bearer → user, the curated tool filter |
| `packages/db/src/schema/assistant.ts` | `assistant_thread`, `assistant_file`, `ai_usage` (+ migration) |
| `apps/app/src/assistant/` | the panel, chips, the quotation card, route-context capture |
| `ConfigProcessPage.tsx` / `ConfiguratorForm` | ✦ ⚙ 💬 markers from the thread's `sources` and the view |
| Settings → Assistant tab | the two switches, with where the data goes |

New dependencies are listed as direct dependencies wherever they are imported:

- `@tanstack/ai`, `@tanstack/ai-anthropic` and `@tanstack/ai-react` (1.0.x); `@tanstack/ai-persistence`
  if used
- phase 2: `@orpc/mcp`, `@better-auth/mcp`, `@better-auth/oauth-provider` and `@better-auth/cimd`

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
- **Unit tests (no API):**
  - the per-model schema from a form state (enums, ranges, a large list as a string)
  - `sources` marker logic (marker gone after a human edit)
  - the page registry (a route's tool set; unknown routes get the general set)
  - the limit (refuses at the limit)
  - the switch (refuses when off)
- **Boundary tests:**
  - a tool call with a forged `x-tenant` is refused
  - a non-admin's tool set has no admin procedure
  - the route refuses without a session
  - phase 2: an MCP token for workspace A on `/api/mcp/<B>` is refused
- `chat()` itself is not unit-tested against a live model. Tests stub the adapter.

## 7. Phases

1. **Extraction**, server only: `extract.ts`, the per-model schema, `ai_usage`, `config_project.sources`,
   the eval script. Proven on a few hand-attached dev drawings. There isn't yet a real test set to
   settle the model choice, so it starts on Sonnet 5.5 (§6).
2. **The panel**: route, threads, files, tools, page context, chips, markers, the quotation card, the
   Settings tab.
3. **MCP**.

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
| Where the switches live | Table `assistant_settings` (tenant pk, `assistant` boolean). The `mcp` column comes with phase 3. |
| How ⚙ is known | Already known: `FieldState.defaulted` (a `defaultExpr` filled it). Rules only eliminate options and never set values, so ⚙ is the existing "Auto" status. |
| Enum size | `ENUM_MAX = 60` options. Query-backed fields are always a string in the schema, checked against the cache (`queryTablePage({ match })`). A hand-typed list past 60 is still listed whole in the model block. |
| `@tanstack/ai-persistence` | Not used: one jsonb column plus an append under a lease is less code, and its store merges *client* messages by id, which §4.7 forbids. |
| Intake orchestration | Fixed steps from the panel: `assistant.intake`, `assistant.start`, `assistant.extract`. The chat model runs only for typed messages. |
| Monthly limit | `ASSISTANT_MONTHLY_LIMIT_USD`, default 25, one value for every workspace. |
| Drawings in the chat's context | Kept: a thread's files stay at the turn they were dropped and are re-sent each turn under prompt caching. |
| Per-workspace MCP resource | Phase 3. |
| Prices | Verified 2026-10-24 on platform.claude.com/docs/en/about-claude/pricing: Sonnet 5.5 $2 / $2.50 cache write / $0.10 cache read / $10; Haiku 5.5 $0.10 / $0.125 / $0.01 / $0.50 (×5 past 100k prompt tokens). |
| Prompt wording, effort | `EXTRACT_SYSTEM`, `INTAKE_SYSTEM` and `SYSTEM` in `apps/server/src/assistant/`; effort left at the model's default until the eval has about 30 cases (§6). |
| Data in the chat | Cards, not prose: the tool's name picks the card (`apps/app/src/assistant/cards/registry.tsx`), the card draws the tool's output, and the model writes one or two sentences around it. |
| Product name | "Assistant" (`da` icon): "Joule" is SAP's. |

## 10. My calls

- No classifier or OCR model; the model choice is a cheap first call, extraction a second.
- Extraction fills empty fields only; a disagreement with an existing value is a question.
- Provenance on the configuration (`config_project.sources`, an optional `calculate` input); the
  chat must give a source for every value it sets.
- One thread per user and configuration, plus one general thread with New chat.
- The admin's Assistant tab shows the month's usage against the limit; SQL for the operator.
- Sonnet 5.5 first, Haiku 5.5 tested against it; one model setting.
- Chips and the post button bypass the model (cheaper, faster, and the human click is the write).
- The assistant has no posting tool; it proposes, the card posts.
- Both workspace switches are off by default.
- The limit is measured in cost; the count of assisted configurations is reported for pricing.
- Over MCP, `createQuote` is included, marked destructive, behind `quoteDraft`'s `commandId`. The
  user's AI may fill header fields through the same server-side filter (`QUOTE_HEADER`). There is no
  quote page over MCP, so a missing required field ends in SAP refusing the post, not in a bad document.
- The eval reads only workspaces with the assistant switched on, and the model choice waits for about
  30 cases.
- The MCP address carries the workspace slug.
- Extraction first, then UI, then MCP.
- The dropped files are kept as the configuration's files: they grow the test set for free.
