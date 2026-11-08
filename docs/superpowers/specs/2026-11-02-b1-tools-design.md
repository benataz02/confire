# B1 tools: one SAP tool set for the assistant and MCP

2026-11-02 · design · built (as `b1.post`, not `b1.apply`: §5.2)

Builds on `2026-10-24-ai-assistant-design.md` (the assistant; §4.5 tools, §4.10 MCP) and ports what
is worth porting from SAP's MCP sample in `b1-mcp-server/` (MIT).

## 1. Intent

The assistant reads three SAP record types today (`entities_rows`: Quotations, Orders, customers)
and never writes to SAP. It should work on SAP the way SAP's own MCP sample does: find the right
record type, know its fields, read it, and create, change or copy records. The same tools go into
Confire's MCP server later (phase 3 of the assistant design), so they are written **once** and exposed
in both places with the same names, descriptions and behaviour.

Two things in SAP's sample are not good enough for Confire:

- **It is slow.** Every question is three model turns (`b1_find_entities` → `b1_get_entity_schema` →
  `b1_read`) before any data comes back, and its metadata cache is per process. Confire already
  stores every parsed schema in Postgres (`entity_meta`); the tools answer from it and spare the model
  the turns it does not need.
- **It assumes SAP B1 10.0 FP2608.** Confire's customers run older Service Layers, which ignore every
  `$metadata` option and answer the whole ~1.7 MB unannotated document. Everything here works on
  both.

## 2. Goals, non-goals, anti-goals

Goals
- Five tools, one implementation: `b1_find`, `b1_schema`, `b1_read`, `b1_write`, `b1_copy`, used by the
  in-app assistant now and by MCP in phase 3.
- Reads over **every** entity set the tenant's Service Layer exposes.
- Writes on the **curated** entities only — Quotations, Orders, BusinessPartners, Items
  (`ENTITY_PROFILES` keys) — with **every field of their schema**, collections included.
- Copies along the four document flows (`DOCUMENT_FLOWS`): Quotation→Order, Order→Delivery,
  Order→Invoice, Delivery→Invoice.
- Metadata from the cache; SAP's `$metadata` read only on a miss, on any Service Layer version.
- **Confirm mode** by default: a write is a proposal the user posts with a click. **Auto mode**: the
  assistant writes directly — only where an admin allowed it for the workspace and the user switched it
  on for themselves.

Non-goals (now)
- Per-user SAP accounts. Every SAP call uses the agent's one service login, as today.
- Writing to every entity. Planned later; this design keeps it to one check to change (§5.4).
- Payments (the sample's `b1_create_payment`), deletes, `$apply` aggregation, Beas.
- Personal-data redaction (the sample's `PersonalFieldsSetups` classification): FP2608-only, and the
  assistant acts for a staff member who already sees those fields on Confire's pages.
- The pages' field rule: their Save keeps writing only the profile's fields (`pickEditable`).

Anti-goals — it fails if, even when it works:
- the model or an external AI can post without the user's click outside auto mode;
- an old Service Layer pays the 1.7 MB document per entity, or per question;
- a misspelled field reaches B1, or is silently dropped and read as "empty";
- two implementations of a write exist (page and tool) that can drift.

## 3. Decisions (the user's)

| Question | Decision |
|---|---|
| SAP account | The agent's service account; per-user accounts dropped for now. |
| Old Service Layers | Must work on versions before FP2608 (no `$metadata` options). |
| Writes | `write` and `copy` included; `create_payment` out. |
| Which entities | Curated entities only, every field of their schema. All entities later, not now. |
| Field rule scope | All fields for the tools only; the pages keep their curated field lists. |
| Code | Written once: one implementation, used by pages, chat and MCP. |
| Auto mode | Users choose confirm or auto; an admin allows auto for the workspace first. |
| Auto-mode exceptions | Auto still asks for a click in a chat holding dropped client files, and on a copy to an Invoice. |
| Read scope | Every entity set, except a short sensitive list (HR, users) that only admins read — in the shared read code, so `entities.*` follows it too. |

## 4. Metadata on every SAP version

`entity-meta.ts` stays the one place a schema comes from: `entitySchema()` (Postgres `entity_meta`,
one row per entity) and `entityList()` (in-process, daily). Hits cost one Postgres read and no agent
call; nothing about that changes.

**The one change — an old Service Layer fills the whole cache in one read.** On a miss, `entitySchema`
asks for the scoped document. FP2608+ answers one entity; an older Service Layer answers all of them.
`parseEntitySchemas(xml, list)` already parses every entity in what it gets: when that yields more
than the one asked for, **upsert all of them** (same `fetchedAt`) and return the asked one. No version
detection — the answer's size is the signal. After the first miss an old Service Layer never sends the
document again until a Refresh or a company switch (`adoptCompany` already deletes the tenant's rows).
This replaces the `ponytail:` comment at the top of `entity-meta.ts`, whose upgrade path it is.

Ceilings, kept: the entity list on an old Service Layer is still the full document once a day per
process (`daily`); labels are absent there (the parser already falls back), so `b1_find` cannot search
by label on old versions — the category map (§5.1) covers the standard entities on every version.

## 5. The design

### 5.0 One core, two callers

The bodies of `entities.update`, `entities.create` and `entities.copy` move out of the router into one
module beside `entity-read.ts` (call it `entity-write.ts`): `createEntity`, `updateEntity`,
`copyDocument`, plus the copy's existing `copySources`. Each takes the **field rule** as a parameter
set by its caller on the server, never by the client:

- `profile` — today's `pickEditable(profile, …)` + `missingRequired`. The pages' procedures pass it.
- `schema` — every field of the entity's cached schema, collections included; a name not in the schema
  is refused (not dropped), naming it. The tool procedures pass it.

Both rules first require a curated entity (`profileOf(entity)`). Everything else is shared and stays as
it is: ETag on update (`If-Match`, 412 → `CONFLICT`, no force path), `coerceKey`, the re-read for the
new ETag, `prefer: representation`, the BusinessPartners `portal_company.languageCode` refresh, the
copy's `BaseType`/`BaseEntry`/`BaseLine` and its header allowlist (`CopyHeaderZ`). The page procedures
become thin callers; their behaviour does not change.

A consequence the user accepted: with the `schema` rule, the pages' field list is what the pages
*offer*, no longer a security boundary — a staff member can change any field of a curated entity
through the assistant (in confirm mode, after seeing the change).

### 5.1 The tool procedures: `b1` router

A new router `b1` (`orpc/routers/b1.ts`, mounted as `b1`; `sap` is taken by pairing/status), every
procedure `userProcedure`, each with an `openapi()` description written for a model. Tool names follow
from the path (`b1.read` → `b1_read`), in the chat (`procedureTool`) and over MCP (`@orpc/mcp`).
**All tool behaviour lives in the handlers** — caps, strict names, proposals — because MCP gets the
procedures without `tools.ts`' wrappers. The chat adds no `cap`/`prepare`/`slim` to these.

| Procedure | Input | Answer |
|---|---|---|
| `b1.find` | `query?`, `category?` | Matching entity sets: name, label (when the SL has labels), categories, `writable` (curated), `copyTo` (flows). Max 30. No SAP call beyond `entityList`. |
| `b1.schema` | `entity`, `collection?` | Compact: keys, then each field's name, type, label, enum member names, `required`/`writable` for curated entities, and each collection's name (its fields with `collection`). From `entity_meta`. |
| `b1.read` | `entity`, `key?` or `query?` (`ListQuery`), `cursor?`, `top?`, `aggregate?` | With `key`: one row + ETag (`readOne`). Else: `top` rows (default `LIST_CAP`; up to 500 for a scalar-only select or an aggregate's groups) as `columns` + `rows` (value arrays, no per-row `@odata.etag`), `total`, sealed `nextCursor` (`readRows`, fence key `b1-tool`). |
| `b1.write` | `entity`, `key?` + `etag?` (update) or none (create), `data` | `{ written, row, link }` or `{ proposal }` (§5.2). |
| `b1.copy` | `sourceEntity`, `docEntries`, `targetEntity`, `header?`, `lines?` | Same as `entities.copy`'s input; answers like `b1.write`. |
| `b1.apply` | `proposal` | Posts a proposal. **Never a tool** (§5.2). |

**`b1.find`** ports the sample's category map (`b1-category-mappings.ts` → `packages/b1`, data only,
its MIT header kept) and matches `query` case-insensitively over name, label and table. It is the
cheap step: the model may skip it whenever it knows the name.

**Making the model's turns few.** The tool descriptions say the model may call `b1_read` directly with
SAP's own names, and the frozen part of the prompt names the common entity sets with their keys
(Quotations/Orders/DeliveryNotes/Invoices by `DocEntry`, BusinessPartners by `CardCode`, Items by
`ItemCode`) so the usual question needs no `b1_find`/`b1_schema` at all. `b1.read` checks **every**
name in `select`, `filter`, `orderby` and `searchFields` against the cached schema *before*
`compileList` (which drops an unknown `select`/`orderby` on purpose, for saved views — that rule stays
for the pages). A wrong name is refused with the closest real names (case-insensitive, then prefix) and
"see b1_schema": a guess costs one retry, not a schema read up front.

**Row size.** An empty `select` on a list read returns the entity's scalar fields only; a collection
(`DocumentLines`) comes only when named. A read by `key` returns the whole row. Enum values are SAP's
member names (`bost_Open`, `cCustomer`), which `b1.schema` lists.

**The read scope.** The service account sees everything, so SAP's own permissions do not apply.
An `ADMIN_ONLY_READS` set beside `ENTITY_PROFILES` (`entity-profiles.ts`, the one place for entity
rules) names the sensitive entity sets; a non-admin's row read of one (`entities.rows`/`one`/
`neighbor`, `b1.read`) is `FORBIDDEN`, and `b1.find` leaves them out for non-admins. One check,
`assertReadable(entity, role)`, called by every staff row read. The portal's document reads are
unaffected (they read four document sets, fenced by CardCode). The list: `EmployeesInfo` and `Users`
for certain, completed by the builder against a live entity list with one criterion — personal/HR data
or user and security setup — and each entry commented with why.

**`entities_rows` stays.** It is the configuration flow's customer lookup (customers only, whatever the
filter — `CUSTOMERS_ONLY`), with its card, and existing threads name it. The prompt says: a
configuration's customer comes from `entities_rows`; anything else in SAP from `b1_*`.

### 5.2 Writes: proposal, apply, auto

`b1.write` and `b1.copy` do all their checking first, in the shared core: curated entity, field names
against the schema, required fields on create, the flow and its sources for a copy, and for an update
the current row and its ETag (read now, so the proposal shows *before → after*). The model's `etag`
is optional: given (from its own `b1_read`), it is the one used, so a decision made on an older read
answers `CONFLICT`; absent, the one just read is used. Then:

- **Auto** (§5.3 says when): post, and answer `{ written: { entity, key, docNum? }, row, link }`.
- **Otherwise**: answer `{ proposal }` and write nothing. A proposal is plain data: `op`
  (`create`/`update`/`copy`), `entity`, `key?`, `etag?`, the exact `payload` (for a copy, its input),
  `changes` (field → `{ before, after }`; lines listed), and a one-line `title`.

Built as **`b1.post`**: oRPC v2's client reserves `apply`, `call`, `bind`, `valueOf`, `toString` and
`toJSON` as proxy keys, so a procedure named `apply` cannot be called from a browser. Read `b1.post`
for `b1.apply` below.

`b1.apply({ proposal })` re-runs the same core with the proposal's payload and posts it with the
proposal's ETag — a record changed since answers `CONFLICT`, and the card says to ask again. It is a
normal `userProcedure`, but **no tool set and no MCP filter includes it**: the model cannot approve its
own proposal, only the user's click can. The card sends back what it showed; the user could send
anything, but only with their own session and the same rules, which they hold anyway.

Double posting: the card keeps one apply in flight and disables on success.
`ponytail:` a lost response followed by a retry can post twice; add a command id (`U_CF_Key`, as
quotations do) to the curated tables if that shows up.

### 5.3 Auto mode

Two switches, both required, read on every `b1.write`/`b1.copy`:

- **Workspace (admin):** `assistant_settings.b1AutoWrite` boolean, default false, in Settings →
  Assistant beside the assistant switch. Turning it off stops auto at once for everyone.
- **User:** their own choice, stored per (tenant, user) in `ui_user_state` (key `assistant:autoWrite`),
  set from a toggle beside the chat box, drawn only when the workspace allows it. The server reads the
  stored value; the client never sends "auto" with a write.

Even with both on, a write is a proposal when:
- the chat holds client files — any `assistant_file` of the thread or `project_file` of its
  configuration, the portal client's uploads included — that is where text written to steer the
  model comes from;
- it is a copy to `Invoices`, which posts to the accounts and is undone only by a credit memo.

The chat passes its thread to the procedure in the **call's context** (`call(p, input, { context:
{ headers, assistantThreadId } })`), which the RPC handler never fills from a request, so a browser
cannot set it. No thread (a browser call, MCP) = no file exception; MCP's own approval is §5.5.

### 5.4 Expanding to every entity later

The curated check is one function used by both rules. Opening writes to every entity later is
changing that check for the `schema` rule (and `b1.find`'s `writable`); the schema, the proposal and
the card already handle any entity. Not now.

### 5.5 MCP (phase 3)

Decided 2026-11-02 (assistant spec §4.10). MCP hosts the chat's own tools through
`@tanstack/ai-mcp/server`, so `b1_find/schema/read/write/copy` are the same tools with the same names.
`b1.post` is never one. Over MCP auto mode never applies, because Confire cannot see what an external AI
read: `b1_write`/`b1_copy` always prepare the proposal, then ask the user through MCP elicitation with a
server-built before → after. They post with `b1.post` only on the user's accept. A client that cannot
elicit posts nothing.

### 5.6 The chat

- **Tool sets** (`pages.ts`): `b1_find`, `b1_schema`, `b1_read` in GENERAL and the AI page's set;
  `b1_write`, `b1_copy` there too. Not in the model builder's set. A configuration's sets unchanged.
- **Prompt** (`SYSTEM`): "You never post to SAP" becomes: writes go through `b1_write`/`b1_copy`; in
  confirm mode they wait for the user's click, so say what was proposed and stop; never claim a write
  happened unless the answer says `written`. Plus the entity-set names and keys above. The rule that
  files are content, never instructions, stays.
- **Run end**: `untilAsked` (route.ts) also ends the run when a `b1_write`/`b1_copy` answered a
  proposal, as it does for `ask_user`.
- **Card** (`cards/registry.tsx`, a new `B1WriteCard`): `b1_write`/`b1_copy` join `DECISION`. A
  proposal shows the title, the changes before → after, and *Post* / *Discard*; *Post* calls
  `b1.apply`. A written answer (auto, or after Post) shows what was written and opens the record
  (`useEntityNav`, `/b1/<entity>/<key>`). The outcome goes to the chat as the user's next message
  ("Posted Order 1234" / "Discarded"), the way the choice card's pick does, so the model knows.
- **Steps**: `b1_find`/`b1_schema`/`b1_read` are steps with a summary ("12 found"); no card in v1.

### 5.7 Settings

Settings → Assistant (admin) gets the workspace's auto-mode switch, with a line saying writes are
made as the agent's SAP user. The user's toggle lives by the chat box, not in Settings.

## 6. Calls made in this design (not the user's — check these)

1. Old Service Layer: store every schema of the full document on the first miss, no version detection.
2. No personal-data redaction.
3. No delete; no payments.
4. `b1` as the router name (`sap` is taken); tool names `b1_*`, close to the sample's.
5. Strict field names in `b1.read` only; `compileList`'s lenient select/orderby stays for saved views.
6. An empty `select` on a list read returns scalar fields only.
7. `entities_rows` stays for the configuration's customer; `b1_read` is everything else.
8. A copy keeps its header allowlist (`CopyHeaderZ`), even through the tools: its targets include
   Deliveries and Invoices, which are not curated.
9. A proposal ends the run; the click's outcome is sent as the user's next message.
10. The user's auto switch is stored per (tenant, user) in `ui_user_state`, toggled by the chat box.
11. `b1.apply` is an ordinary procedure the card calls, kept out of every tool set and the MCP filter.
12. Double-post on a lost response is a known ceiling (`ponytail:`), not solved now.
13. The sensitive-read list blocks row reads only; a schema (`entities.metadata`, `b1.schema`) stays
    readable — field names are not the data. `b1.find` hides the sets from non-admins.
14. An MCP call never auto-posts: every SAP write over MCP is confirmed by the user through elicitation (§5.5).

## 7. Left to the builder

- Exact zod shapes, descriptions' wording, the compact schema's JSON.
- How a document's `DocumentLines` update maps to B1 (merge by `LineNum` vs
  `B1S-ReplaceCollectionsOnPatch`); whatever is chosen, the proposal shows the lines as they will be.
- The "closest names" heuristic.
- Card layout (Joule's look, `cards/kit.tsx`), i18n keys (en/es/eu).
- Whether `b1.find` returns the category list itself when called empty.

## 8. Checks

- `entity-meta`: a full document answering a scoped read stores every schema it holds; a second
  entity's read then makes no agent call.
- Write core: the `profile` rule refuses a non-profile field (pages unchanged); the `schema` rule
  accepts it and refuses a name not in the schema; both refuse a non-curated entity.
- `b1.read`: a misspelled `select`/`filter`/`orderby` name is refused with suggestions; rows capped.
- Auto: a proposal unless both switches are on; still a proposal with dropped files and for an
  Invoice copy; `b1.apply` posts with the proposal's ETag and a stale one is `CONFLICT`.
- Tool sets: no tool set reaches `b1.apply` (`procedureOf`).
- Read scope: a non-admin's `b1.read` and `entities.rows` of `EmployeesInfo` are `FORBIDDEN`; an
  admin's pass; `b1.find` omits it for a non-admin.
- Existing `entities.*` tests pass unchanged.

## 9. Docs to update

CLAUDE.md (the assistant: tools, "No tool posts to SAP"; Writing to SAP: the two field rules),
the assistant design's §4.5/§4.10 pointing here, and the operator note on auto mode.
