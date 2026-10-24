# The configuration process: the server computes, the browser draws

2026-10-24 · design, for approval

## 1. Why

The staff process page (`apps/app/src/components/configurator/ConfigProcessPage.tsx`) runs the
configuration engine in the browser, and the server runs the same functions again for what it stores
and posts:

| In the browser today | Also on the server |
|---|---|
| `propagate`: visibility, options, defaults, required, conflicts | `calculateProject`, `buildQuoteSeed` |
| `itemMoney` → `computeOutputs` + `itemSplit`: the Cost elements pane and the items grid's money | `buildQuoteLines` |
| `paramPrices`: the option price badges | the portal's `toPortalBadges` |
| `missingInputs`: the Create quote gate | `buildQuoteSeed`, the portal's submit |
| `evalTableRows`: formula cells | `itemSplit`, `tableAggregates` |

Two copies of every figure means two places for it to drift. One real case: after a price sync,
`calculateProject` reuses the stored candidates (its reuse check looks at the model, not the
masterdata), so the Candidates grid shows the old price while the pane re-prices with the new one,
and the posted quotation uses the new one. To make the browser copy possible, the page also downloads
the model's expressions, every lookup table and the BOM item prices. And each `calculate` answer
carries `project.candidates`: up to 200 candidates × every batch quantity, each with its full BOM and
routing lines. That is the biggest thing on the wire, and the page reads only a few numbers from it.

What the user wants: **one source of truth, the server.** The browser sends what the user changed.
The server works out everything and answers with what the screen shows, and the browser draws that.
The same calls are what a future MCP server will expose, so an AI client can take a user through a
configuration: ask for the mandatory fields, show the candidates and the cost breakdown, pick, quote.

The portal already works this way (`2026-10-07-portal-redesign.md` §7.1). This design brings the
staff page to that model and goes further on both: patches of changed fields instead of whole-state
sends, no timer, and an answer shaped like the screen rather than like the engine's internals.

## 2. Decided by the user

- The server is the single source of truth for every output of the configuration process.
- While a change is being processed the page shows nothing predicted: it waits for the server.
- Candidates are calculated only once every mandatory field is filled.
- The 1 s timer goes if that is better. It is (§4.1).
- A big-bang rewrite and file restructure, not an incremental migration.
- Prepare for a future MCP. Through it, a client asks for every mandatory field and shows the user
  what the screen shows: the cost breakdown, the candidates, and the rest.

## 3. Goals, non-goals, anti-goals

**Goals**
1. Every figure, rule result and classification on the process page comes from the server.
2. One request per committed change, carrying only what changed. One answer, carrying what the
   screen shows, without the engine's raw output.
3. Candidates exist only when nothing mandatory is missing.
4. The pane, the grid, the Candidates tab and the posted quotation come out of the same code path
   and cannot disagree.
5. The calls form a complete, self-describing process an MCP server can register as-is.
6. The restructure leaves fewer, smaller files with one job each.

**Non-goals**
- The MCP server itself: OAuth, how a token names a tenant, tool curation.
- The model builder's live preview. It previews an *unsaved* model, which the server has no row for,
  and nothing it shows is stored or quoted (my call, §8).
- Quote posting (`quoteDraft`, `createQuote`, the U_CF_Key idempotency): only its line builder starts
  sharing the money code (§4.4).
- A UX redesign. Sections, rail, footer and the General-first rule look and behave as today, apart
  from what waiting for the server changes.
- Row ids or per-cell table patches (§4.2).
- A schema change. Candidates keep their stored shape, so there is no migration.

**Anti-goals: a failure even if it works**
- Any number, rule or classification on the process page computed in the browser, beyond formatting
  and the sort, filter and grouping the user drives.
- Two places on the page showing different figures for the same thing, or a figure the quotation
  will not carry.
- A request per keystroke.
- An answer that ships every candidate's BOM and routing lines.
- Silently losing something the user entered (a refusal reverts, and says why: §4.1).
- The portal's fence loosening: a client still never receives an expression, a cost or `prices`.

## 4. Design

### 4.1 The interaction

- **Every control commits on change**: UI5's `change` (blur or Enter), a select, a checkbox, a batch
  token, a value-help pick, and Add/Duplicate/Delete/paste in a grid. `ConfigTable`'s typed cells and
  its unit-price cell use `onInput` today, which would become a request per keystroke. They move to
  `change`.
- **A commit is sent at once. No timer.** Commit events already group the typing, so a timer would
  only add a second of lag. (The user allowed it; removing it is my call.)
- **One call in flight per page.** Commits made meanwhile merge into one pending patch, sent when the
  call returns. Candidate picks go through the same queue, behind any pending edit, and the
  Candidates grid stops taking picks while an edit is pending or in flight, as it does today with
  `draft !== null`. A pick must never land on a candidate list its edit is about to replace.
- **While waiting**, the controls show what the user entered: the pending patch laid over the last
  answer's values. That echoes input; it computes nothing. Everything derived (visibility, options,
  defaults, badges, formula cells, money, candidates, messages) keeps the last answer, marked busy,
  until the new one lands (my call).
- **A refusal** (4xx: unknown field, wrong type, a locked project) drops the pending patch, refetches
  the view so the form shows what the server holds, and says what was refused. **A failure to reach
  the server** (network, 5xx) keeps the pending patch and offers a retry, so nothing typed is lost.
- **A calculation that cannot produce candidates** (no valid configuration, a formula error) is not a
  refusal. The inputs are saved and the view says why (`calculation`, §4.3).

### 4.2 The edit call

```ts
configs.calculate({
  id: string,
  name?: string,
  customer?: { cardCode: string; cardName: string } | null,
  set?: Entries,       // parameter values to write
  unset?: string[],    // parameter keys to clear: null is a value (ValZ), so clearing needs its own list
  batches?: number[],  // the whole list
  tables?: TableRows,  // each changed table's full rows; a table not named is left alone
}) → ConfigView
```

- **Name and customer move here** from `configs.update`, so every field the user fills is one call,
  and one MCP tool. `update` keeps only the model switch, which wipes the inputs and stays a separate,
  deliberate act (my call).
- **Validated against the model before anything is written**, refused with one message naming every
  problem:
  - a key that is not a parameter
  - a read-only parameter
  - a value of the wrong type: number, boolean or string, or string[] for a multicombo
  - a table the model does not declare, or a column it does not declare
- **Not refused: a value outside its field's options.** Options depend on other fields and on the
  cache. Today nothing flags such a value, because the UI never offers one, but an API client can
  send one. So it becomes an issue in the view (`not_an_option`, §4.3).
- **One `UPDATE` that merges in SQL**: `entries = entries || set - unset`, `tables = tables || tables`.
  Because the merge happens in SQL, two writers editing different fields (a browser tab and an MCP
  session) never overwrite each other.
- **What empties the calculation.** A patch of engine inputs (`set`, `unset`, `batches`, `tables`)
  empties `candidates`/`selection`/`calculatedAt` in the same statement. That keeps the invariant that
  inputs and candidates move together. Name and customer do not feed the engine, so a rename or a new
  customer keeps the candidates and the user's picks. The exception is `customer: null`: it leaves
  something mandatory missing, so it empties the calculation too, and candidates never outlive the
  gate. (`name` is `min(1)` after trimming, so it can never be cleared.)
- `ponytail:` tables are replaced per table, not per cell. Rows have no identity to merge on (the same
  ceiling `acceptPortalInputs` names). Per-row patches can come once rows get ids.
- `calculate({ id })` with no patch is valid and answers the current view (§4.5).

### 4.3 The view

`ConfigView` is what `get`, `calculate`, `select` and `update` all answer. It is **plain JSON**:
`Propagation.defaulted` is a `Set` today, and in the view it becomes an array. That way the RPC client,
`/api/openapi` and a future MCP all see the same thing. The browser derives nothing from it except
formatting.

| Part | What | Replaces, in the browser |
|---|---|---|
| `project` | The row as the page uses it: name, customer, status, modelId, entries, batches, `tables` (the stored rows, where typed overrides and typed prices live), selection, calculatedAt, b1DocEntry, b1Company, quoteResponse, portalCardCode, assigneeId, updatedAt. **Without `candidates`.** | — |
| `model` | `{ id, name, definition }`, on `get` and after a model switch only, as today | — |
| `request`, `sapCompany` | As today | — |
| `form.fields` | Per parameter key: value, defaulted, visible, required, options (value, label, the reason it is unavailable), price badge, the conflicts that mark it | `propagate`, `paramPrices`, `domainOf`, the form's `broken` map |
| `form.conflicts`, `form.open` | Rule violations (the author's messages and their parameters); how many fields are still open | `propagate` |
| `form.tables` | Each table's rows evaluated, formula cells filled in | `evalTableRows` (ConfigTable, the page) |
| `missing` | What is still needed, in form order: General's name, customer and batch quantities, then the required parameters and the items grid's rows and cells. Each has key, code and message. **Empty ⇔ candidates are calculated ⇔ Create quote can show.** | `missingInputs`, `headReady`, `gaps` |
| `calculation` | `waiting` (something is missing, or there are conflicts), `current`, or `failed` with its message | `shouldCalc`, `runReady`, calc errors |
| `candidates` | `keys`: the parameters that differ between candidates, in model order. `rows`: assignment plus, per batch quantity, `{ unitPrice, unitCost, total, margin, lowest }`. `capped`, `widest`. | `toPriced`, `openKeys`, `bestByBatch`, `margin` |
| `costs` | Per batch quantity, what the Cost elements pane and the items grid show: materials (BOM by description), operations (by resource), total cost, price (a typed price wins), margin, and per items-grid row `{ unitCost, unitPrice, quantity, lineCost }`. Priced on the pairs selected at that quantity, else the first picked configuration, else the first candidate: today's `itemMoney` rule. Every quantity at once, so switching the shown quantity needs no call. Present whenever there are candidates; `items` is empty for a model without an items grid. Today the pane shows nothing without one (my call). | `itemMoney`, `moneyTotals`, CostBody's sums |
| `optionPrices` | The informational per-option prices and their total | `paramPrices` + the rail's sum |
| `selection` | The picks and their total | `selectedTotal` |
| `issues` | The rest of what the message popover says that the server knows: BOM items priced at 0, the 200-candidate cap with its widest field, a table never synced or whose last sync failed, an entry outside its options | `unpricedItems`, `lookups.sync`, half of `configMessages` |

- **Messages** in `missing` and `issues` carry a stable `code` and its `params`, so each page can
  translate them with its own i18n bundle. They also carry an English `message` for the API and MCP.
  Today `missingInputs`' messages are English strings the page shows as they are.
- **Out of the view**: the raw candidate outputs (today's `project.candidates`) and the lookups'
  `prices`.
- **The display tables stay a separate cached query**, `configs.lookups({ modelId })`. They hold the
  value-help seeds, the table cells' options and the extra text next to a select option. The query is
  cut to what drawing needs, `tables` only:
  - no `prices`: they feed only the engine
  - no `domains`: the view carries the options
  - no per-configuration `entries` enrichment: the server binds stored values itself
  - no `sync`: that now comes through `issues`

  These tables are display data, not an input to any figure, and they change only on a sync. Sending
  them with every edit would recreate the giant payload (my call).

### 4.4 What the server does

`calculate`:
1. `assertWritable` (internal side).
2. Validate the patch: a pure function shared with the portal, with each side's rules (§4.6).
3. The merge `UPDATE`, if the patch is not empty.
4. Build the view. Load the row, the model and `cachedLookups`, then run `propagate` and work out
   `missing`. If the project is writable, nothing is missing, there are no conflicts, and its
   calculation is absent or stale (§4.5), run `calculateProject`. Then compose the view.

`get`, `update` and `select` do step 4 after their own reads and writes.

**`calculateProject` changes**
- **The gate.** It never enumerates while `missing` is non-empty or there are conflicts. This is the
  portal handler's rule today, moved into the shared path.
- **Failure is state.** No valid configuration, or a `DslError`, becomes `calculation: failed` in the
  view instead of a thrown `BAD_REQUEST`, as the portal's `calcError` already does. `configs.duplicate`
  then keeps a copy whose calculation failed, as a draft showing why, instead of rolling it back. Its
  `ponytail:` comment already names that flip. A failure is not stored: the next read of a complete
  project tries again. That is cheap, and it picks up a fixed model or a refilled cache without a
  user action.
- **Its final `UPDATE` writes the calculation only**: candidates, selection and calculatedAt. Today it
  also rewrites the `entries` and `batches` it read, which can undo a patch that landed in between.
  The write only goes through if `updatedAt` still equals what it read. If another write won, its
  result is dropped and the view is built once from the newer row. No loop: the newer writer's own
  call calculates.

**One money unit.** One engine function prices one (candidate, batch quantity) pair: outputs, then
`itemSplit`, then a typed price wins. The view's `costs` and `buildQuoteLines` both call it, so the
pane and the posted quotation come out of the same code. Today `itemMoney` and `buildQuoteLines`
each rebuild that sequence around `itemSplit`.

The view reads the outputs stored on the candidates, which §4.5 keeps current, and does not re-run
`computeOutputs` per read. `buildQuoteLines` still recomputes when quoting: the post is priced live,
unchanged.

### 4.5 Staleness

- A stored calculation is **stale** when the model changed after it (today's rule), or when any
  masterdata row the model reads (`syncTables`) was synced or edited after it. The second case is
  new, read off `config_masterdata.syncedAt` and `updatedAt`, and closes the gap described in §1.
- **Every call that answers a view refreshes a stale calculation of a writable project first**, so a
  view is always current. That needs no client effect and no extra MCP step. A locked project (quoted,
  or a request not in review) shows its stored calculation as it is.
- This replaces the staff page's "calculate when there are no candidates" effect and the portal's
  `needsCalc` effect.

### 4.6 The portal

The portal is in this rewrite for the parts it shares (my call). Its fence does not change.

- `projects.calculate` takes the same patch shape: `set`, `unset`, `batches`, `tables`. The name stays
  on its `update`, and the portal has no customer. Its validation is the shared patch validator with
  the external rules, which are today's `acceptPortalInputs` rules: no read-only parameter, and no
  formula or unit-price cell.
- Its form state comes from the same engine function as the staff page's. `projection.ts` then
  filters it, as `toPortalProp` does today: parameter keys only, values of visible fields only.
- Commit-and-send, no timer, and refresh on read (§4.5). Its `needsCalc` effect goes.
- **Unchanged**: what it shows (no candidates, no cost; prices per §7.2 of the portal spec), and the
  fenced lookups in its payload.

### 4.7 The browser

**Removed from the staff process page**
- Every call into the engine: `propagate`, `paramPrices`, `missingInputs`, `evalTableRows`,
  `computeOutputs`, `itemSplit`, `bindings`.
- `itemMoney.ts`.
- The query-pick binding (`QueryPicks`, `mergeQueryPicks`, `setQueryPick`). The server binds a picked
  off-page row from the stored entry (`bindEntryValues`), which the portal already relies on.
- The `draft`/`selOverride` overlays and the timer effects.
- `runView`'s money helpers (`toPriced`, `bestByBatch`, `margin`, `openKeys`, `unpricedItems`) and its
  hand-written mirrors of server types. Types come from the router through oRPC inference.

**Kept in the browser**: formatting (money, percent), the sort, filter and grouping the user drives
in a grid, which rows the price chart draws, which batch quantity the items section shows, and
section navigation.

**Restructure.** `ConfigProcessPage.tsx` (750 lines) becomes the page layout plus:
- `useConfigProcess`: the `get` query, the write queue (patch merge, one in flight, picks behind
  edits), the pending overlay and the error policy. It is the only module that calls the `configs.*`
  writes.
- `GeneralForm` and `ProcessFooter`, moved out as they are.
- `InsightsRail` draws `view.costs` and `view.optionPrices`. `PriceAnalysis` draws `view.candidates`.
  `configMessages` translates `missing`, `issues` and `form.conflicts`, plus the page's own errors (a
  failed lookups load, a failed sync, a refused write).

The exact split is the builder's.

**`packages/ui`**
- `ConfiguratorForm` takes the model, the form state and the display tables. It no longer takes
  `lk`, `prop`, `badges`, `onQueryPick` or `evaluated`, and never calls the engine.
- `ConfigTable` always takes its evaluated rows and its per-row money as props. Whether formula cells
  can be overridden becomes a flag of its own (staff yes, portal no) instead of following from
  "evaluated rows were given".
- Both commit on change (§4.1).
- The patch merge helper is pure and tested, and lives here because both SPAs queue the same patch
  shape.

**Model builder preview**: it keeps running `propagate` in the browser on the unsaved draft. It turns
the result into the same form state with the same engine function, so `ConfiguratorForm` has one
input shape.

### 4.8 MCP readiness

`@orpc/mcp` registers oRPC procedures as MCP tools, with descriptions taken from the procedures'
meta. What this design does so that the MCP becomes a registration later:

- **The process is a short, complete sequence of calls**: `create` → `get` → `calculate` until
  `missing` is empty → `select` → `quoteDraft` → `createQuote`. Alongside: `queryPage` to search a
  value-help field's options, `similar`, and `update` for a model switch.
- **Each gets a description**, and its input fields a `.describe()`, written for someone who has
  never seen the page: what the call does, what it refuses, what comes back. Check the exact v2 meta
  API with the `orpc` skill.
- **Inputs are patches a client can build from a sentence** ("set width to 1200"). Refusals name the
  field and the reason, so a client can correct itself.
- **The answer is the view**: plain JSON, with English messages and labels. That is enough to ask for
  each missing field and to present candidates and costs without the page.
- **Field-level merge** lets an MCP session and a browser tab work on the same configuration.
- `ponytail:` `get` carries the full model definition (labels, sections and expressions). If an MCP
  client finds it too noisy, add a labels-only projection then.

## 5. Code layout

| Path | What |
|---|---|
| `packages/config-engine/src/form-state.ts` | **new**, pure: `formState(model, lookups, prop, tableRows)` → the plain-JSON form state (§4.3 `form`) |
| `packages/config-engine/src/money.ts` | **new**, pure: the one money unit (§4.4) and the per-quantity cost breakdown. The `RowMoney`/`CostLine`/`ItemMoney` types move here from `packages/ui/src/money.ts`, because the producer owns them. `itemMoney.test.ts` moves here. |
| `apps/server/src/config-view.ts` | **new**: the view, as a pure composition (tested) plus the loader that reads the row, model and lookups |
| `apps/server/src/config-patch.ts` | **new**: patch validation per side (pure, tested; takes over `acceptPortalInputs`' rules) and the SQL merge |
| `apps/server/src/config-project.ts` | `calculateProject`: the gate, staleness, the conditional write, failure as state |
| `apps/server/src/config-quote.ts` | `buildQuoteLines` on the engine's money unit |
| `apps/server/src/orpc/routers/configs.ts` | `calculate` takes the patch; `update` keeps the model switch; every view-returning procedure answers the view; `lookups` slimmed; descriptions |
| `apps/server/src/portal/projection.ts` | `toPortalProp` becomes the fence over `formState`; `acceptPortalInputs` moves into `config-patch.ts` |
| `apps/server/src/portal/orpc/projects.ts` | Patch input, refresh on read, the payload's form from `formState` |
| `packages/ui/src/configurator/` | `ConfiguratorForm` and `ConfigTable` props (§4.7); `formHelpers` without query picks; `patch.ts` **new** |
| `apps/app/src/components/configurator/` | The page split; `itemMoney.ts` deleted; `runView.ts` trimmed; `InsightsRail`, `PriceAnalysis` and `configMessages` draw the view |
| `apps/portal/src/routes/$slug/projects/$id.tsx` | The queue, no timer, no `needsCalc` |
| `apps/app/src/components/model-builder/ParamsTab.tsx` | `formState()` before `ConfiguratorForm` |
| `CLAUDE.md` | The config-engine section ("the same code runs in the browser for live preview") and the "browser propagates for preview" note in `configs.ts`: the engine now runs in the browser only in the model builder preview |

## 6. Tests

Each should fail if its part of the design breaks.

**Server**
- **Patch semantics**:
  - a patch writes only its own fields
  - `set` then `unset` of the same key
  - tables are replaced per table
  - a second writer's different field survives (the SQL merge)
- **Refusals**: an unknown key, a read-only parameter, a wrong type, an undeclared table or column.
  Each is named in the message, and nothing is written.
- **The gate**: no candidates while any of these is missing: a required parameter, the name, the
  customer, a batch quantity, an items-grid requirement. The call that fills the last one answers
  with candidates.
- **Failure as state**: no valid configuration → the inputs are saved and `calculation` is `failed`
  with the message.
- **Staleness**: a masterdata sync after a calculation → the next `get` answers with the new price.
  The same after a model edit. A quoted project never recalculates.
- **The conditional write**: a patch landing between `calculateProject`'s read and write is not undone.
- **One money unit**: for the same selection, the view's `costs` equal `buildQuoteLines`' lines,
  including a typed price. Every batch quantity is present.
- **Plain JSON**: `get` through `/api/openapi` equals `get` through RPC. Extend `openapi.test.ts`.
- **Portal**: the projection tests against the fenced form state; `acceptPortalInputs`' cases rerun
  against the shared validator's external rules.

**Engine**: `money.ts` (the moved `itemMoney` tests), `form-state.ts`.

**UI**: the patch merge helper (set then unset, unset then set, table replace, order).

**Gate before done**: every project's typecheck (`packages/{b1,config-engine,db,ui}`,
`apps/{server,app,portal}`), both SPA builds, `bun test`, `bun run test:ui`.

## 7. Left to the builder

- The names of new types, files and helpers (the procedures keep theirs), and the exact split of the
  page.
- The list of `missing`/`issues` codes.
- How "busy" looks.
- Whether the extra text next to a select option moves into the view's options.
- The wording of refusals.
- The order of work inside the big bang.

## 8. My calls

These are mine, not the user's; check them while reading.

1. The 1 s timer goes (§4.1).
2. Name and customer join the edit call; `update` keeps only the model switch (§4.2).
3. The display tables stay a separate cached query, slimmed to `tables` (§4.3).
4. "Mandatory" is the quote gate: General's name, customer and batch quantities, the required
   parameters and the items grid (§4.3 `missing`).
5. Every view-returning call refreshes a stale calculation itself (§4.5).
6. The portal is in for its shared parts, with its fence unchanged (§4.6).
7. The model builder preview keeps the engine in the browser (§3, §4.7).
8. While waiting, the last answer stays on screen, marked busy (§4.1).
9. The cost breakdown shows for models without an items grid too (§4.3 `costs`).
