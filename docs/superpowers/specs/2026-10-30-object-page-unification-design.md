# One Object Page: the model builder on the shared shell

2026-10-30. Status: built 2026-10-30 (see *As built* at the end).

## Why

Today the app saves in three ways:

| Page | Today |
|---|---|
| B1 records (`/b1/*`), quote page, masterdata editor, portal onboarding/documents | the shared `ObjectPage` (`packages/ui/src/object-page/ObjectPage.tsx`): display → Edit → Save the changed fields |
| Model builder (`ModelBuilderPage.tsx`) | its own hand-built UI5 `ObjectPage` over `useDraftModel`: a draft, checked live, an explicit Save of `diffModel`'s patch; Portal publishes the moment it is switched |
| Configurator (`ConfigProcessPage.tsx`) | autosave: one commit per change, the server answers the whole view |

`ParamPage` and `TablePage` already sit on the shared `ObjectPage`, but only by bending it: a fake
`EntityConstraints` (`CONSTRAINTS`), the whole parameter or table as "the record's one field",
`isNew` + `createLabel` to get a page that is always editing, and every section a template. They take
the chrome and declare nothing.

The owner wants **two** ways, not three:

- **Explicit save, on the shared Object Page**: B1 records *and* the model builder (with its parameter
  and table pages). Save sends the changed fields. No ETag for models.
- **Autosave**: the configurator only.

And **one way to declare a page**: the model builder is declared like `apps/app/src/features/b1/documents.tsx`
(sections, subsections, groups, fields, templates as data) and rendered by the shared shell, not
hand-built.

## Goals

1. The model builder, its parameter page and its table page are shared `ObjectPage`s driven by a
   declared `DetailFeature`, like a B1 record.
2. One record lifecycle for every explicit-save page: a buffer, a dirty flag, **Save sends what
   changed**, Cancel discards, leaving with unsaved changes asks. The builder pages are **always in
   edit mode** (no Edit button) and stay in edit mode after a save, on a fresh baseline.
3. A page with two separate forms lays them out as **`ObjectPageSubSection`s** — never
   `FormGroup headerText`, never a hand-drawn heading.
4. **Every Object Page reports problems through one messages button in the title** (`PageMessages`),
   with per-section counts. No red `MessageStrip` for errors. The popover **opens by itself only when
   an action comes back refused** (Save; in the configurator, an autosave or a failed calculation),
   and only for `Negative` messages — never while typing, never for warnings.
5. **Every form in both SPAs has labels beside the field** — declared forms, templates, dialogs, the
   configurator and the portal alike. Nobody sets labels on top any more.
6. **Clean up**: what this replaces is deleted, not left next to the new code. No backwards
   compatibility is kept for any of the props, hooks or components this retires.

## Non-goals

- The configurator keeps autosave and its own page. Its only changes: `PageMessages` moves package
  (below), the auto-open rule applies to it, and its form's labels move beside the field (§5).
- No server-side model draft, no model versioning, no "release" step.
- No ETag on models. `models.save`'s row-lock merge of `diffModel`'s patch (`apps/server/src/orpc/routers/models.ts`)
  stays; so do `checkModel`, `diffModel`, `applyModelPatch`, `ModelPatchZ`. The one server change is
  §2's: the portal columns ride on `models.save`/`create`, and `models.publish` goes.
- B1 pages keep their behaviour (display → Edit, lines editable on a new document only, ETag, the
  existence probes, SAP error matching). Only how they *report* problems changes.

## Anti-goals (a failure even if it works)

- **Builder-only branches in the shared shell.** Every new prop or option must mean something for any
  record ("always editing", "a validator", "a control kind"), never "if this is the model builder".
- **Two validators for one rule.** The builder's errors come from `checkModel` only. A declared
  `required` on a builder field draws the asterisk; it must not produce a second, differently worded
  error next to `checkModel`'s.
- **Losing the draft between the builder, the parameter page and the table page.** They are sibling
  routes under `ModelDraftScope`; opening a parameter unmounts the builder page today and must not drop
  a single edit.
- **A popover that opens under the cursor** while an expression is half typed.
- **Fake entities.** No `EntityConstraints` invented to get a page to render.

## Decided by the owner

- Two ways of working: explicit-save Object Page (B1 + model builder) and autosave (configurator).
- Builder always in edit mode; Save sends the changed fields; no ETag.
- Two forms on a page → `ObjectPageSubSection`s.
- Portal publish moves behind Save (no switch on the page applies itself), and **`models.publish` is
  deleted**: `models.save` stores the portal columns with everything else. The portal catalog keeps
  reading `config_model.portal` as it does now.
- One messages button on every Object Page, B1 and portal included; the red strip goes.
- It opens itself only when an action comes back refused, Negative only.
- Labels beside the field, **uniformly across the whole app** — the configurator and the portal
  included.
- Restructure freely; no backwards compatibility.
- Check every UI5 component API used against the UI5 MCP (`mcp__ui5-wcr__get_component_api`) while
  building — pretrained knowledge of `@ui5/webcomponents-react` is not to be trusted for props.

## The design

### 1. The record lifecycle leaves the component: `useObjectRecord`

Everything `ObjectPage` keeps in state today — `formData`, `baseline`, `editing`, `errors`,
`existence`, `cellErrors`, `touched`, the pending value-help probes, `saving`, the leave guard
(`useBlocker`) and the save pipeline (wait for probes → re-probe changed value helps → cell probes →
field rules → `onSave`) — moves into one hook in `packages/ui/src/object-page/`.

`ObjectPage` takes either its present props (it creates the hook itself: every B1 page, the quote
page, masterdata, the portal) or a `record` made outside it. The model scope makes one and keeps it
alive across the builder, parameter and table routes, which is what lets the draft survive.

New options, each meaningful for any record:

| Option | Meaning |
|---|---|
| `alwaysEdit` | editing from the first render, baseline = data, no Edit button; after a successful save the saved record becomes the baseline and editing goes on. Replaces the `isNew` + `createLabel` workaround. |
| `validate(formData)` | the record's own rules. When given, it **replaces** declared-rule validation (`validateForm`); declared `required` then only draws the asterisk. Its answer covers fields (by key) and table cells (`<row>:<column>` under the table key) — the shapes the page already keeps. Value-help existence probes still run. |
| `sameRecord(current, next)` | the leave guard's "not leaving" predicate. Default: the same pathname (today's rule). The model scope passes `sameModelPath` (`paramRoute.ts`). |
| metadata optional | a record with no entity behind it (no `constraints`) treats every declared field as editable and takes label/type from the declaration. This is what retires the fake `CONSTRAINTS`. |
| `onSave(diff, { formData, baseline, … })` | the caller gets the whole record and its baseline too, so a nested record can compute its own diff. |
| `save(next?)` | saves `next` when given — for a caller that has just changed the record in the same tick (today's `m.save(def)` exists for exactly this). |
| `update(fn)` | one edit that touches several fields (a structure op deletes a parameter *and* its placement *and* the rules naming it): `updateField` is one key. The builder's templates edit through `fn(record)`, folding to and from `ModelDef` around `structureOps`. |

Errors shown: a record loaded from the server shows `validate`'s errors at once; a new one shows them
after its first Save (today's builder `tried` rule, generalised).

### 2. The model as a record

`ModelDraftScope` holds the model record. Its fields:

- the `ModelDef`'s top-level parts (`name`, `description`, `batchDefaults`, `parameters`, `structure`,
  `computed`, `tables`, `constraints`, `bom`, `routing`, `history`);
- `pricing` flattened to `pricing.priceList`, `pricing.itemTable`, `pricing.priceExpr`,
  `pricing.quoteItemCode` — flat dotted keys as the portal onboarding form already does with
  `BillTo.*`, and each key equal to `checkModel`'s issue path, so an issue lands on its field with no
  mapping;
- `portal`, `portalPricing` from the `config_model` row.

A pure `toRecord`/`fromRecord` pair converts. **Save** is one call: `models.save` with
`diffModel(fromRecord(baseline), fromRecord(formData))` plus `portal`/`portalPricing` when they
changed (or `models.create` with the whole definition and the portal fields when new, then navigate
to `/models/$id` as today).

On the server, `models.save` and `models.create` take optional `portal` and `portalPricing` beside
the definition. **`updatedAt` moves only when the definition patch is non-empty**: it is what makes a
stored calculation stale (CLAUDE.md, "Nothing is snapshotted"), and a portal switch cannot change a
calculation — the reason `publish` was a separate call. A portal-only save skips `checkModel` (the
stored definition already passed it) but keeps the row lock. `models.publish` and its client are
deleted. `validate` = `checkModel`
over `fromRecord(formData)` (deferred, as `useDraftModel` does now) plus the empty-name rule, mapped:
`pricing.*` to its field, `bom[i].x` / `routing[i].x` / `constraints[i].x` / `history.mappings[i].x`
to that table's cell, and everything about parameters, tables and structure to the Parameters section
(today's `sectionOf` / `anchorOf` stay the mapping).

### 3. The declarations

A new feature module for the builder (location and file split are the builder's; `apps/app/src/features/model/`
reads like `features/b1/`). It declares three `DetailFeature`s — the model, a parameter, a table —
built with `t` so their labels are the bundle's.

The model's sections (tabs, see §5):

| Section | Content |
|---|---|
| Settings | subsections **Model** (name, description, batch quantities), **Pricing** (price list value help, item source, price formula, quote item value help), **Portal** (publish switch, portal prices select) |
| Parameters | template: the structure tree and the live preview (`fitContent`) |
| Rules | subsections **Expression rules** (a declared table: when / must hold / message) and **Combination tables** (template: its list and edit dialog) |
| Item structure | subsections **BOM** and **Routing**, each a declared table |
| History | subsections **Source** (query, fields) and **Mappings** (a declared table) |

The parameter page: **Definition** and **Behavior** declared; **Domain** stays a template (its
manual-options grid, range and masterdata source switch with the kind). The table page: **Definition**
declared, **Fields** a template.

What the shared declaration types gain, each general:

- `Subsection` may hold `fields` or a `table`, like a `Section` (today only `groups`).
- `Section.fitContent` (IconTabBar only — see the UI5 facts below).
- `DetailFeature.mode: "tabs"` (IconTabBar) beside the default scrolling page; in tabs mode the open
  section is in the URL (`useSectionParam` moves from `apps/app/src/lib` into the shared page).
- `FormField.help`: the ⓘ beside the label (ParamForm's `lbl`, which every builder field has).
- **Control kinds**: `FormField.controlType` and `ListColumn` name a control the page was given in a
  `controls` map (`expr` → `ExprInput`, `masterdataQuery` → `MasterdataQuerySelect`,
  `batches` → `BatchField`). One entry serves every field and grid cell of that kind, instead of a
  `fieldTemplate` per field. `FormField` and `EditGrid` both look it up.
- A table's lines editable in edit mode when the record has no metadata. The B1 rule ("lines only on
  a new document", for `ReplaceCollectionsOnPatch`) stays tied to metadata.

### 4. Messages on every Object Page

- `PageMessages` moves from `apps/app/src/components/` into `@confire/ui`; its texts move into the ui
  bundle, so the portal has them.
- The shared page draws it in the title and builds its list from its own state (field errors,
  existence errors, cell errors, an unmatched save failure) plus the caller's extra messages (the
  builder's: lookups failed, the preview falling behind, a duplicate/delete refusal).
- Each section's anchor/tab shows its Negative count (today's builder `secTitle`, now every page's).
  A message names its section; the page knows each field's section from the declaration.
- **Auto-open**: the page counts refused actions — a Save stopped by validation or a rejected
  `onSave`. When the count goes up and there is a Negative message, the popover opens on the button.
  The configurator counts a refused autosave (`queue.error.refused`) and a `calculation: failed`.
  Typing never opens it; warnings never open it.
- The `pageError` `MessageStrip` goes. `notice` (an informational strip, the quote page's and
  onboarding's) stays: it is information, not a problem.

### 5. Layout

- **Labels beside is UI5's default**, so the uniform pattern is to *not set* `labelSpan`: its default
  `S12 M4 L4 XL4` puts the label beside its field, and on top only below 600 px — of the form's own
  width, not the window's, so a narrow dialog or a form beside the configurator's cost rail falls back
  to labels on top by itself. Every `labelSpan="S12 M12 L12 XL12"` and the masterdata editor's
  `S12 M3 L3 XL3` go. The one exception is `GridForm` (`Grid.tsx`), whose single item is a grid with no
  label.
- **One column constant**, exported from `@confire/ui` (today's `formOf` value, `S1 M2 L3 XL3`), used
  by every `Form` that does not have a reason in a comment to differ. The builder's `FORM` / `PAIRS` /
  `SPAN2` / `SPAN3` and the configurator's `FORM_PROPS` go.
- **This covers the whole app**: the shared `formOf`, `ConfiguratorForm` (staff configurator, the
  builder's preview, the portal's project page), `GeneralForm`, Settings (`settings.tsx`,
  `PortalBranding`), the builder's dialogs (`TitleDialog`, the combination-table dialog), the
  masterdata editor, and the portal's `company.tsx` and `projects/$id.tsx`.
- `ConfiguratorForm` puts an option's price at the label's right end because, with labels on top,
  that is the field's top-right corner (its comment says so). Beside the field, that place is gone; the
  price needs a new one next to its field, checked in the browser on the staff and the portal page.
- The builder is `mode: "tabs"`; Parameters is `fitContent` so the splitter gets a height.
- Subsections only where a section has two or more blocks (UI5's own rule, below); a one-form section
  puts its form straight in the section.

### 6. What gets deleted

- `ModelBuilderPage`'s hand-built UI5 `ObjectPage`, `secTitle`, its footer.
- `useDraftModel`'s `draft` / `dirty` / `tried` / `save` / blocker; `draftScope.tsx`'s own `useBlocker`.
  What stays is what the record does not hold: `tableCols`, the deferred `checkModel`.
- `ParamPage` / `TablePage` / `MasterdataEditor`: `CONSTRAINTS`, `isNew` / `createLabel`, their
  `tried`, the `sectionTemplates` that only existed to draw forms that can now be declared.
- `SettingsTab`, `PortalSettings` (and its immediate publish), every `FormGroup headerText` in the
  builder, `bad()` / `shown()`.
- `models.publish` (server) and `orpc.models.publish` (its one caller, `SettingsTab`).
- Every `labelSpan` but `GridForm`'s; the per-file layout constants (§5).
- `builderMessages` shrinks to the builder's `validate` mapping and its extra messages.
- `useEditGrid` once BOM, routing, expression rules and mappings are declared tables.
- The shared page's red strip.

## UI5 facts, checked with the UI5 MCP (`@ui5/webcomponents-react` 2.27.2)

- `ObjectPageSection.fitContent` **only takes effect in IconTabBar mode**; content that should fill or
  scroll is wrapped in an element with `flex: 1; min-height: 0`.
- `ObjectPageSubSection` has `titleText` (required), `hideTitleText` and an `actions` slot (no
  overflow). UI5: use subsections only when there is more than one.
- `ObjectPageSection` has a `header` slot and `hideTitleText`.
- `MessageViewButton` has `type` and `counter` but **no open state**: the page owns the popover, and
  auto-open needs a ref to the button to anchor it (today the opener comes from the click event).
- `Form`: `labelSpan` defaults to `S12 M4 L4 XL4` (labels beside; `12` = on top); the S/M/L/XL
  breakpoints (600 / 1024 / 1440 px) are measured on the form itself; `layout` defaults to
  `S1 M1 L2 XL3`. Standalone `FormItem`s outside a `FormGroup` are **deprecated since 2.23** — every
  item goes in a group (as `formOf` already does).

## My calls (the owner can override)

- **Cancel on an always-editing page leaves** to the parent (the list, or the model from a parameter),
  asking first if dirty — what the builder and parameter page do today.
- **A parameter or table page's Save writes into the model record and saves the model**, then returns
  — today's behaviour.
- **The preview-position picker** moves from the title's navigation bar into the Parameters section
  itself (it only means something there, and the declared title has no per-section slot).
- **Message button placement**: first in the title's actions bar, on every shared Object Page.
- **Declarations are functions of `t`**, not English literals mapped afterwards (`features/b1/localize.ts`'s way).
- **The masterdata editor moves too.** `MasterdataEditor.tsx` uses the same workaround (a fake
  `CONSTRAINTS`, `isNew` + `createLabel`, everything a template); it becomes an `alwaysEdit` record
  with declared sections like the builder's, under the "no fake entities" anti-goal.
- **A message's jump** switches the tab in tabs mode (`useSectionParam.go`) and scrolls the section
  into view on a scrolling page (the configurator's `goSection`), so the shared page does both.

## Left to the builder

Names and file layout; how `ObjectPage` takes an outside `record`; the exact shape of `validate`'s
answer; where `toRecord`/`fromRecord` live; how the combination-table dialog hangs off its template;
the order of the work.

## Checks

- One test for `toRecord`/`fromRecord`: a round trip is the identity, and a change through the record
  diffs to the same `diffModel` patch as the change on the `ModelDef`.
- The `builderMessages` tests follow its new shape.
- One case in `apps/server/test/models.test.ts` (integration, needs `DATABASE_URL`): a save of the
  portal fields alone stores them and leaves `updatedAt` where it was; a definition change moves it.
- One shared-page test (`bun run test:ui`): `alwaysEdit` takes the saved record as the new baseline;
  `validate` replaces declared rules; the refused-action count goes up on a refused Save and not on an
  edit.
- Type-check every project the change touches: `packages/ui`, `apps/app`, `apps/portal`
  (`bunx tsc -p <project>/tsconfig.json --noEmit`), and `bun --cwd apps/app build` /
  `bun --cwd apps/portal build`.
- Drive it in the browser (the headless probe in memory): a model edit → Save → reload shows it; open a
  parameter and come back with the draft intact; a refused Save opens the popover; typing a broken
  expression does not.

## Docs to update with it

`CLAUDE.md`'s *List Report / Object Page* section (the record hook, `alwaysEdit`, control kinds,
messages on every page, subsections, labels beside) and its mention of the builder's own page; its
*Portal projects* line "set by `models.publish`, not by `save` — publishing must not bump `updatedAt`"
becomes "saved by `models.save` beside the definition; only a definition change bumps `updatedAt`".
The schema comment on `config_model.portal` gets the same wording.

## As built

The owner's answers during the build, and what the build added beyond the design:

- **Every red strip on an Object Page went**, the configurator's too: the staff "New configuration"
  page, the portal's project page and its company page carry the messages button. Their auto-open is
  the configurator's rule (a refused autosave, a failed calculation; on the company page a refused
  role change), counted by `useRefusals`.
- **`useEditGrid` is deleted.** Every editable grid is `EditGrid`: the declared ones, and inside
  templates the combination-table dialog's rows, a parameter's manual options, the table page's
  Fields, the masterdata Rows and Query columns. Cells that are not plain fields are control kinds.
- **An option's price closes its control's row** (after the assistant's mark), staff and portal.
- General additions to the shared shell: a control kind may `patch` several values (a mapping's
  parameter and table, an item pick that fills its description); `SectionTable.newRow` and
  `SectionTable.onChange` (the masterdata rows follow their columns); `FormField.onChange` gets the
  record before the edit; `onSave` may resolve with the record as stored (the masterdata query's
  `$select` is what B1 answered); a filled required select has no empty option; Save is enabled on
  a new record (pressing it is what shows what it needs).
- **No `labelSpan` anywhere**, `GridForm` included: a grid's form item spans its whole item grid
  (`TABLE_ITEM`), which is what the default label column used to squeeze.
- The masterdata editor's Columns grid is declared; Rows (columns that follow the record), Query
  columns, Cache and Preview stay templates. The table page's Fields stay a template, as designed.

