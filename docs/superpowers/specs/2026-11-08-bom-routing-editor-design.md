# BOM and routing editor, with Beas operations — design

2026-11-08. The model builder's Outputs section: how an admin adds and edits BOM materials and routing
operations, and how a routing line links to a Beas operation whose times and rate are read live, the
way BOM prices are.

## Why

Today BOM and routing are two inline `EditGrid`s (`features/model/model.ts`, `outputs` section). It
works, but formulas and conditions sit in narrow cells. The item cell is a value help that writes
`"CODE"`, so a formula-chosen item shows up as raw text in a picker. Routing has no link to Beas at
all: `resource` is free text, and setup, run and rate are numbers typed by hand that go stale when
production changes them in Beas.

The manufacturers who use Confire keep their operations in the Beas `OperationsCatalog`. Authors
should pick an operation and get its figures, and those figures should follow Beas from then on.
That is how BOM materials already follow the price list: "nothing is snapshotted" (CLAUDE.md).

## Goals

- Each list (BOM, routing) is a read-only summary table with **one Add button** ("Add line") and
  Delete. Clicking a line, or Add line, opens **a modal dialog** for that line. Not a page: a line
  has about seven fields, and the builder already edits formulas, titles and combination tables in
  dialogs.
- **Item** and **Operation** each have a **Pick / Formula** switch. Pick opens a value help (SAP
  `Items`, Beas `OperationsCatalog`). Formula uses `ExprInput` with suggestions.
- **Picking an operation fills every field it maps to**: description, resource, setup, run, rate.
  The three figures are filled as live references (`beasSetup`, `beasRun`, `beasRate`), not copies
  of the numbers.
- **Resource** has a value help over Beas `Resource`.
- **A routing line may have no Beas operation** (user, 2026-11-09). Workspaces without Beas keep
  today's routing: the resource is typed and the figures are numbers or formulas.
- On every calculation the catalog figures come from the masterdata cache, like prices. An
  operation missing from the cache is a warning on the process page, never a failed calculation.

## Non-goals

- Bulk add ("Add materials…", "Add from Beas…" multi-select). The user turned this down: one
  Add button, then pick.
- Writing a Beas routing or work order for the configured item. This work is costing only.
- Moving lines up and down. Today's grid has no reordering either; add it when it is asked for.
- Catalog fields the routing line has nowhere to put and costing does not use: `Section`, `OpGroup`,
  `OperationType`, `ProductionUnit`, `OperationSort`, `AddOperation`. Add them when a Beas routing
  write needs them.
- The resource's own cost rates (`Resource.*CostRate`). The rate is the operation's `CostRate`
  (see Decisions).
- A "no price" marker in the builder's BOM table. The process page already names every unpriced
  item.

## Anti-goals (failure even if it works)

- Copying catalog numbers into the model when an operation is picked. A model would then quote
  Beas as it was on the day someone picked the operation.
- One operation missing from the cache stops a calculation, or costs 0 without a word.
- A per-line page, with its own route, leave guard and draft scope, for seven fields.
- Any Beas read during a calculation. The runtime reads Postgres only (CLAUDE.md, "The masterdata
  cache").

## What Beas actually does (verified live on hera, 2026-11-08, GETs only)

- **`OperationsCatalog`**, key `OperationId`. Sample row: `{"OperationId":"ACA_AGUJEROS","Description":"AGUJEROS",
  "OperationType":"operation","ResourceId":"ACA_ACABADO         ","Section":"ACABADO","SetupTime":5,
  "ProductionTime":0.1,"ProductionUnit":"Piezas","CostRate":21,"QuantityPer":1,…}`.
  - `ResourceId` comes back **padded with spaces** (char(20)). Trim every string read from Beas.
  - `ProductionTime` and `CostRate` are declared `Edm.Int32` in the EDMX but return decimals
    (0.1). Read numbers by value, never by the declared type.
- **`Resource`**, key `ResourceId`: `ResourceDescription`, `ResourceGroup`, `Active`,
  `EfficiencyRate`, `Setup/Processing Full/Marginal CostRate`, …
- **Filter dialect** (also in the Beas docs, help.beascloud.com/script202609, `bslfilter.htm`):
  - `like` / `startwith` / `endwith` exist; `contains()` and every other function are refused.
  - `Description like 'aguj'` matches anywhere in the text and ignores case, with no `%` needed.
  - `ResourceId eq 'ACA_ACABADO'` matches the padded value.
- **Paging:** `$top` alone is refused ("Define both or none"), and `$top`+`$skip` without
  `$orderby` is refused ("only allowed, if an $orderby is defined"). `OperationsCatalog/$count` is
  refused too.
- **Units** (user: "rate is always hourly, time in minutes", for every installation): no unit
  field and no conversion.

## Decisions

### Model (`packages/config-engine/src/model.ts`)

```ts
export const OperationZ = z.object({
  /** expr -> a Beas OperationId. Absent = a hand-written line with no catalog link: every model
   *  saved before this change, and every line in a workspace without Beas. */
  operationId: z.string().optional(),
  /** plain text; empty = the catalog's ResourceId for the evaluated operation */
  resource: z.string().optional(),
  desc: z.string().optional(),
  condition: z.string().optional(),
  setupMin: z.string(),      // expr, minutes per batch
  runMinPerUnit: z.string(), // expr, minutes per unit
  ratePerHour: z.string(),   // expr, cost per hour
});
```

- `pricing.operationTable?: string` sits beside `pricing.itemTable`. It names a masterdata query
  (target `beas`, entity set `OperationsCatalog`) whose cached rows hold the operations.
- No DB migration: the definition is jsonb and both additions are optional. A routing line with
  no `operationId` behaves exactly as today.
- `resource` becomes optional. A line saved with `resource: ""` keeps loading and now falls back
  to the catalog's resource.

### The three catalog names

In a routing line that has an `operationId`, the expressions `setupMin`, `runMinPerUnit` and
`ratePerHour` may use `beasSetup`, `beasRun` and `beasRate` (plus `qty`, as today):

- `beasSetup` = `SetupTime`
- `beasRun` = `ProductionTime / QuantityPer`. A `QuantityPer` that is null or 0 counts as 1.
- `beasRate` = `CostRate`

`condition` and `operationId` do not get these names: the operation has to be known before its
figures are, and a condition that depends on catalog figures is not a case anyone has.

### Calculation (`output.ts` → `computeOutputs`)

For each included routing line with an `operationId`:

1. Evaluate the expression to a string and trim it.
2. Look the code up in `lookups.operations`.
3. Evaluate `setupMin`, `runMinPerUnit` and `ratePerHour` in a scope that adds the three names.
   If the operation is missing, the names are 0 and the line's `OpResult` carries
   `uncatalogued: true`, mirroring `unpriced`.

The `OpResult` also changes:
- It gains `operationId?: string`.
- `resource` = `o.resource || catalog.resource || ""`.
- `desc` = `o.desc || catalog.desc || ""`.

Errors keep naming the line as "Routing line N".

### Lookups (the seam)

`ResolvedLookups.operations?: Record<string, { desc: string; resource: string; setupMin: number;
runMinPerUnit: number; ratePerHour: number }>`.

- It is built server-side (`apps/server/src/lookups.ts`, a `cachedOperations` beside
  `cachedPrices`). It reads the cached rows of `pricing.operationTable` by `OperationId`, limited to
  the operations the model can produce.
- `routingOperationIds(model, domains)` decides which operations those are. It follows the same
  rule as `bomItemCodes`: the string literals in the expression, plus the resolved domain of a bare
  identifier. Share the walk between the two.
- Field names are hardcoded, for the same reason `ITEM_CODE`/`ITEM_PRICES` are. A null or missing
  number counts as 0. A missing row means the operation is absent.
- `syncTables` adds `pricing.operationTable`, so the cache is kept fresh and the delete guard
  protects it.
- Both the canonical resolve and `cachedLookups`' per-configuration path carry `operations`, the
  same way `prices` is merged.

### Checks (`check.ts`)

- `routing[i].operationId` is checked as an expression with the model's names plus `qty`, like
  `bom[i].itemCode`.
- `beasSetup`/`beasRun`/`beasRate` are known names in setup/run/rate only when the line has an
  `operationId`. Elsewhere they are the usual unknown-reference error.
- A model with any routing line that has an `operationId` and no `pricing.operationTable` is
  refused: "a routing line linked to a Beas operation needs an operations masterdata query".
  An unknown table name is refused, like `itemTable`.

### Process page

`config-view.ts` adds an issue `uncatalogued` with params `[operationId]`, next to `unpriced`, and
`configMessages.ts` gives it a warning text: the operation is not in the operations source and its
Beas figures counted as 0.

### Builder: tables and dialog (`apps/app/src/components/model-builder/`)

- In `features/model/model.ts`, the `bom` and `routing` subsections drop their `table` declarations
  and become `subsectionTemplates`, like `combinations` (`CombinationTables.tsx` is the pattern: a
  `Grid` with `onRowClick`, `selectionMode="Multiple"`, toolbar Add line and Delete).
- **BOM table** columns:
  - `#`
  - Item: the code in bold with the description under it. A formula shows in monospace with
    "N possible items" under it.
  - When: a chip, "Always" when the condition is empty, otherwise the condition in monospace.
  - Qty per unit, in monospace.
- **Routing table** columns:
  - `#`
  - Operation: the code in bold with "description · resource" under it. A formula shows like the
    BOM's, with "N possible operations".
  - When, as in the BOM.
  - Setup min, Run min/unit, Rate /h: each expression as written, in monospace.
- **Line dialog** (one component, both kinds):
  - Buffer and commit, like `FormulaDialog`: a new line exists only once OK is pressed, and Cancel
    drops every change. Header "Material N" / "Operation N", or "New material" / "New operation".
  - One-column form (`S1 M1 L1 XL1`), the same reason `FormulaDialog` gives.
  - OK is disabled while `checkModel` reports an issue on this line's paths, checked against the
    draft with the line spliced in at its index.
  - **Item\*:** a `SegmentedButton` with Pick | Formula.
    - Pick is `CflField` over `cfl.items()`: it writes the JSON string literal and fills `desc`
      from `ItemName`. This is today's `itemCode` control.
    - Formula is `ExprInput` (2 rows). Under it: "Can give: TAP-AN, TAP-LAC", from
      `bomItemCodes` over this line with the preview's domains.
    - The dialog opens on Pick when the expression is empty or a single literal (`asCode`),
      otherwise on Formula. Switching to Pick with a non-literal expression empties the field;
      Cancel undoes it.
  - Description; Only when (optional `ExprInput`); Qty per unit\* (`ExprInput`, `qty` known).
  - **Operation** (optional, no asterisk): the same Pick | Formula switch. Left empty, the line is
    a manual one, as today. Pick is a value help over Beas
    `OperationsCatalog` (columns `OperationId`, `Description`, `ResourceId`, `SetupTime`,
    `ProductionTime`, `CostRate`).
    - Picking writes the literal and sets `desc` = `Description` and `resource` = trimmed
      `ResourceId`.
    - It sets setup/run/rate to `beasSetup`/`beasRun`/`beasRate`, replacing a figure that is
      empty, a plain number, or exactly one of the three names. A plain number is either a new
      line's default or a hand-typed figure from before Beas, which is the staleness this work
      removes. Any other formula is the author's (`beasRun * holes`, `area * 0.02`) and
      survives picking another operation. *(My call.)*
    - Formula mode applies the same rule.
    - A new routing line starts with empty figures, not today's `"0"`/`"0"`/`"60"`, so OK waits
      until a pick or a typed value fills them.
  - **Resource:** a value help over Beas `Resource` (`ResourceId`, `ResourceDescription`,
    `ResourceGroup`, fixed filter `Active eq true`). It stores plain text and **accepts typed
    text**, so it works when the Beas read fails or the workspace has no Beas (a failed probe
    already counts as "exists"). Placeholder "from the operation" when an operation is set.
  - **Setup min\*, Run min/unit\*, Rate /h\*:** `ExprInput` with `qty` plus the three names (when
    an operation is set). Under each, a hint with the catalog's current figure, "Beas: 5".
  - When the picked operation is not in `lookups.operations`, the hint says it is not in the
    operations source and counts as 0.
- **Catalog figures in the builder** come from `models.previewLookups`. `lookupSkeleton` (in
  `usePreviewLookups.ts`) must start carrying the routing lines' `operationId` and
  `pricing.operationTable`. The query key then changes when an operation changes, which is a pick:
  rare.
- **Settings → Pricing** gains "Operations source (Beas)": a `masterdataQuery` control on
  `pricing.operationTable`, with help naming the columns it needs. It is optional, and required
  only once a routing line is linked (the check above).
- Every new text is an i18n key in the app's message bundle.

### Beas value helps (backend)

Both pickers read Beas live, as the item picker reads SAP live. Only the calculation reads the
cache. Requirements:

- The Beas filter dialect throughout:
  - Search is `Col like 'term'`, OR'd across the search fields, for the dialog and the type-ahead
    alike.
  - An exact key probe is `eq`.
  - Every page sends `$orderby` (the query's own, else the key) with `$top` and `$skip` together.
  - Nothing asks for a count.
- Trim strings in the rows returned.
- Beas reads from a value help are **admin-only**: only the model builder uses them, and
  `entities.rows` is a staff procedure.
- Fix `withSearch` (`lookups.ts`), which always emits `contains(...)`: for target `beas` it emits
  `like`. The masterdata editor's test fetch goes through it.

The mechanism is the builder's call. My recommendation: a `target: "beas"` on the CFL's entity
source (`types.ts` `CflSource`), served by a Beas branch behind `entities.rows`/`entities.metadata`
over `beasSchemas`. Then type-ahead, dialog, probe and column labels keep one read path.

### Beas query sync

`runnerFor` (`b1.ts`) pages with `Prefer: odata.maxpagesize` plus a bare `$skip`. Beas refuses a
bare `$skip` and any `$skip` without `$orderby`, so **a Beas masterdata query bigger than one page
very likely fails to sync today**. hera's `OperationsCatalog` is that size or close to it.

- For target `beas`, page with `$top`+`$skip`+`$orderby`. Use the query's own `orderby`, else the
  entity's key from `beasSchemas`.
- Treat "more" as a full page, unless Beas turns out to send a next link.
- Verify against hera (GETs only) before relying on it.

## Tests (one runnable check per piece of logic)

- `output.test.ts`:
  - A picked operation costs from the catalog.
  - `beasRun * holes` overrides the run time.
  - A missing operation is `uncatalogued`, and its catalog names count as 0.
  - `resource` and `desc` fall back to the catalog.
- `check.test.ts`:
  - `beasRun` is refused on a line with no `operationId`.
  - `operationTable` is required once a line is linked.
- A server lookups test:
  - `cachedOperations` trims the padded `ResourceId`.
  - `QuantityPer` 0 counts as 1.
  - Only the model's operations are read.
- A `withSearch` test: `beas` → `like`, `b1` → `contains`.
- The dialog's pick rule as a pure helper with a small test, in the style of
  `structureOps.test.ts`: empty, `"60"` and `beasRun` are replaced; `beasRun * holes` and
  `area * 0.02` are kept.

## Left to the builder

- File and component names. Whether the BOM and routing dialogs are one component or two thin
  ones over a shared form.
- The Beas value-help mechanism (recommendation above).
- How a builder message about `bom[i].*` / `routing[i].*` leads to the line. Today it jumps to a
  grid cell that will no longer exist. The requirement: from the messages popover the user reaches
  that line's dialog. Marking the row in the table is welcome.
- Whether a workspace without Beas sees the Operation field and the Operations source setting at
  all. Hide them if the agent's Beas status (`/health` `services.beas`) is already at hand in the
  app; otherwise show them, optional. Either way a manual line must save.
- Whether the table's figure cells show `15 · Beas` for a bare `beasSetup`, or the expression as
  written. The mockup shows the expression.

## Context

- This builds on the uncommitted work on `portal-home` that drops line ids
  (`0023_bom_routing_no_ids.sql`): a line is its place, and errors name "BOM line N" / "Routing
  line N".
- Mockups from the session are in `.superpowers/brainstorm/` (gitignored). `option-b-v2.html` is
  the agreed one.
