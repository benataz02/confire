# List Report & Object Page: architecture, configuration, variants and metadata

This document explains how the two main page shells of the Beas web client work:

- **List Report** (`app-list-report`): filter bar + table, used by every list route (`/items`, `/warehouses`, `/resources`, …).
- **Object Page** (`app-object-page`): header + sections + forms, used by every detail route (`/items/:id`, `/items#create`, …).

It covers how both components are configured for each entity, how templates and variants (saved views) work,
how entity metadata is fetched from the backend, and how that metadata changes the rendered forms and tables.

> **About the source.** This tree was decompiled from minified bundles (see `README.md`). Member names are original. Local
> variables and non-exported helpers still have minifier names (`rg`, `ii`, `p`, `O`, `qc`, …). This document uses those
> names when it refers to the code, and explains what each one does. There are no TypeScript interfaces in the
> source. The "config shapes" below were collected from what the components read, not from type declarations.

---

## Table of contents

1. [Big picture](#1-big-picture)
2. [How a feature wires an entity into the shells](#2-how-a-feature-wires-an-entity-into-the-shells)
3. [List Report](#3-list-report)
   - 3.1 [Inputs / outputs](#31-inputs--outputs)
   - 3.2 [Composition](#32-composition)
   - 3.3 [Filter bar (`beas-header`)](#33-filter-bar-beas-header)
   - 3.4 [Table (`beas-grid`)](#34-table-beas-grid)
   - 3.5 [Data providers and OData query generation](#35-data-providers-and-odata-query-generation)
4. [Object Page](#4-object-page)
   - 4.1 [Inputs / outputs](#41-inputs--outputs)
   - 4.2 [Composition](#42-composition)
   - 4.3 [Object page header](#43-object-page-header-app-object-page-header)
   - 4.4 [Section model: sections → groups / subsections → fields](#44-section-model-sections--groups--subsections--fields)
   - 4.5 [Object page section rendering](#45-object-page-section-rendering-app-object-page-section)
   - 4.6 [Form field (`beas-form-field`)](#46-form-field-beas-form-field)
   - 4.7 [Edit / create / save lifecycle](#47-edit--create--save-lifecycle)
   - 4.8 [Validation](#48-validation)
5. [Templates (content projection hooks)](#5-templates-content-projection-hooks)
6. [Variants (saved views)](#6-variants-saved-views)
   - 6.1 [Grid views (table variants)](#61-grid-views-table-variants)
   - 6.2 [Filter views (filter-bar variants)](#62-filter-views-filter-bar-variants)
   - 6.3 [How the two variant types are linked](#63-how-the-two-variant-types-are-linked)
   - 6.4 [Other per-user persistence](#64-other-per-user-persistence)
   - 6.5 [Object Page "variants"](#65-object-page-variants)
7. [Entity metadata: where it comes from and how it shapes the UI](#7-entity-metadata-where-it-comes-from-and-how-it-shapes-the-ui)
   - 7.1 [Field constraints (`/api/metadata/{Entity}`)](#71-field-constraints-apimetadataentity)
   - 7.2 [Custom fields (`/api/system/CustomFields`)](#72-custom-fields-apisystemcustomfields)
   - 7.3 [UDFs (`/api/system/UdfConfigs`)](#73-udfs-apisystemudfconfigs)
   - 7.4 [Server-side validation errors](#74-server-side-validation-errors)
   - 7.5 [Runtime type inference](#75-runtime-type-inference)
8. [End-to-end flows](#8-end-to-end-flows)
9. [Configuration reference](#9-configuration-reference)
10. [File index](#10-file-index)

---

## 1. Big picture

```
                         ┌────────────── Feature (per entity) ───────────────┐
 route ""   ──────────►  │ XxxView (list)  extends BaseListView (optional)    │
                         │   headerConfig / gridConfig / filterFields /       │
                         │   columns / dataSource / toolbarActions /          │
                         │   systemViews / systemFilterViews / tableId        │
                         └──────────────┬────────────────────────────────────┘
                                        ▼
                    ┌──────────── app-list-report ────────────┐
                    │  beas-header  (title, actions,           │──► FilterViews (GridViews API, "<tableId>::filters")
                    │               filter bar, filter views)  │
                    │  beas-grid    (fdp-table, columns,       │──► GridViews (GridViews API, "<tableId>")
                    │               grid views, settings,      │
                    │               export)                    │──► ODataTableDataProvider ─► REST/OData endpoint
                    │  [listReportFooter] (optional splitter)  │
                    └──────────────────────────────────────────┘

                         ┌────────────── Feature (per entity) ───────────────┐
 route ":id"  ───────►   │ XxxView (detail) extends BaseDetailView            │
 route "#create" ────►   │   data / sections / headerConfig / metadataEntity /│
                         │   customFieldEntityName / permissionResource       │
                         └──────────────┬────────────────────────────────────┘
                                        ▼
                    ┌──────────── app-object-page ────────────┐
                    │  app-object-page-header (avatar, title,  │
                    │     facets, actions, nav, section tabs)  │
                    │  app-object-page-section × N             │──► FieldConstraintsService (/api/metadata/{Entity})
                    │     └ groups / subsections               │──► CustomFieldService (/api/system/CustomFields/…)
                    │         └ beas-form-field × N            │
                    │  floating footer (Save / Cancel)         │
                    │  [side panel]                            │
                    └──────────────────────────────────────────┘
```

**The UI structure is declared in code, not generated from metadata.** Each feature writes its own column list,
filter list, section/field tree and header config as plain object literals in its TypeScript files. Backend
metadata only:

- **adds constraints** to fields that are already declared (`required`, `maxLength`, `min`/`max`, decimals, regex),
  and
- **adds extra fields/columns** that admins configure at runtime (custom fields, UDFs).

---

## 2. How a feature wires an entity into the shells

### Routing

```ts
// features/items/items.routes.ts (simplified)
{ path: '', pathMatch: 'full', canMatch: [createModeMatch],      // URL fragment "#create"
  canDeactivate: [unsavedChangesGuard], data: { isCreate: true }, loadComponent: ItemView },
{ path: '', pathMatch: 'full', loadComponent: ItemsView },        // list
{ path: ':id', data: { entityRef: { keyParams: ['id'], service: ItemsService, labelKey: '…' } },
  children: [{ path: '', canDeactivate: [unsavedChangesGuard], loadComponent: ItemView }, …] }
```

- `createModeMatch` (`core/guards/create-mode.match.ts`) matches when the URL fragment is `create`. So `/items#create`
  loads the **detail** component with `data.isCreate = true`, and `/items` loads the **list**.
- `entityRef` is used by `EntityNotFoundResolver`. Both shells read it (`autoNotFound`) and show a
  "not found / back to list" message when the parent record does not exist.
- `unsavedChangesGuard` calls `BaseDetailView.hasUnsavedChanges()`, which is `objectPage.isEditMode() && objectPage.isDirty()`.

### Base classes (`shared/directives/`)

| Class | Role |
|---|---|
| `BaseListView` | Delete with confirmation (`selectedItems`, `service.delete(extractKey(row))`), `onCreate()` → `navigate([routePath], {fragment:'create'})`, `onRowClick()` → `navigate([routePath, key])`, **custom-field columns** (`customColumns`, `customFieldNames`, `mergeCustomFieldValues`). Re-fetches when the custom-field set changes. Subclass provides `service`, `routePath`, `entityTranslationKey`, `extractKey()`, `refreshDataSource()`, optional `customFieldEntityName`. |
| `BaseDetailView` | `loadByKey()` (404 → `null` → "not found" message), first/prev/next/last navigation through `service.getFirstKey()`… (`/api/system/navigation/{navigationPath}/first|last|previous|next`), `navigateAfterCreate(createAction, key)`, `saveCustomFields()` / `persistCustomFields()`, `hasUnsavedChanges()`. Subclass provides `routePath`, `getService()`, `getKey()`, `isNew()`, optional `customFieldEntityName`. |
| `BaseCrudService` | `controllerPath` → `getEndpoint()`; `getAll/getByKey/create/update(PUT)/delete` with `('key')` OData key formatting. |

### Config generation pattern

Configs are signals recomputed on language change:

```ts
headerConfig = LanguageSignals.computed(this.languageService, () => ({ title: t.instant('…'), icon: 'product' }));
columns      = LanguageSignals.computed(this.languageService, () => [...baseColumns(t), ...this.customColumns()]);
sections     = LanguageSignals.computed(this.languageService, () => buildSections(t, cflConfigs, lookups));
```

Configs that are shared between a list, its CFL (value-help) dialog and other screens live in
`shared/cfl/cfl-configs.ts`. For example, items use `Se()` = header, `Me()` = grid config, `ae()` = filter fields,
`te()` = columns, `Ee` = keys filtered by exact match. Filter fields are often built with the helpers from
`shared/cfl/field-builders.ts` (`createFieldBuilders(t)` → `combo`, `lookup`, `text`, `num`, `yesNo`, `date`, `time`).

---

## 3. List Report

`shared/components/list-report/list-report.ts|html`

### 3.1 Inputs / outputs

| Input | Default | Meaning |
|---|---|---|
| `headerConfig` (required) | | `{ title, icon, iconFont, showSearch, searchPlaceholder, showAdaptFilters, showFilterActions, filterBarExpanded }` |
| `gridConfig` | `{}` | `{ title, selectionMode ('multiple'), showNavigationColumn, activeRow, emptyMessage, projection, virtualScroll, pageScrolling, pageSize, contentDensity, exportConfig, hideItemCount, rowClass }` |
| `filterFields` | `[]` | Filter bar fields (see [§9.2](#92-filter-field)). |
| `columns` (required) | | Grid columns (see [§9.1](#91-grid-column)). |
| `dataSource` (required) | | An array or a fundamental-ngx `TableDataSource` wrapping `ODataTableDataProvider` / `ViewsTableDataProvider`. |
| `toolbarActions` | `[]` | Grid toolbar buttons `{ id, label, glyph, type, showLabel, callback, disabled(), active(), disabledHint, requiresFullControl }`. |
| `headerActions` | `[]` | Page header controls (`controlType: 'button' \| 'segmented' \| 'select'`, `align: 'start'\|'end'`). |
| `permissionResource` | `''` | When set, actions with `requiresFullControl` are hidden unless `permissions.has(resource, 'F')`. |
| `tableId` | `''` | **Enables variants and persistence** (grid views, filter views, panel position). |
| `systemViews` / `systemFilterViews` | `[]` | Built-in read-only variants (see [§6](#6-variants-saved-views)). |
| `mode`, `edit` | `'read'`, `{}` | Inline editing in the grid (array data sources only). |
| `treeMode`, `expandFirstLevel` | `null`, `false` | Tree table. |
| `syncWithUrl` | `true` | Restores `?search=` and expands the filter bar if query params are present. |
| `loading`, `notFound` | | |
| `defaultPanelPosition`, `panelPositionFixed` | `'bottom'`, `false` | Footer panel placement (only with a `listReportFooter` template). |

Outputs: `search`, `filterChange`, `filtersClear`, `selectedItemsChange`, `navigationClick`, `rowDoubleClick`,
`sortChange`, `cellChange`, `rowAdded`, `rowDeleted`.

### 3.2 Composition

```html
<beas-header … [filterFields]="resolvedFilterFields()" [filterViewsTableId]="tableId()"
              [systemFilterViews]="…" [linkedGridViewId]="activeGridViewId()" [gridViewChanged]="…">
<main>
  @if (footerTemplate) { <beas-splitter> <fd-card>GRID</fd-card> <div>FOOTER</div> </beas-splitter> }
  @else               { <fd-card>GRID</fd-card> }
</main>
<!-- GRID = <beas-grid [columns]="resolvedColumns()" [persistence]="{tableId}" [systemViews]="…" …> -->
```

The list report adds the following on top of header and grid:

1. **Filter pool (`buildPool`)**. Every column becomes a possible filter:
   - Explicit `filterFields` are added first (visible unless `visible: false`).
   - Every column with `filterable !== false` that has no explicit filter gets an **auto-generated, hidden** filter
     from `buildFilterFieldFromColumn(col)`:
     - `col.options` → combobox with those options plus "All".
     - `dataType: 'checkbox'` → Yes/No combobox (`'true'`/`'false'`).
     - `dataType: 'color'` → color picker.
     - otherwise the type comes from the column `dataType` through `Uc[dataType].odata`: `date`, `datetime`,
       `number` (number formats keep `numberFormat`, `decimalPlaces`, `uom`), or `text`.
   - The user can show these hidden filters with **Adapt Filters**. When the header reorders or toggles fields,
     `onPooledFilterFieldsChange` stores the new order, and the next `buildPool` run keeps the user's order and visibility.
2. **Template resolution**: `listReportCell="ColName"` templates are attached to columns as `cellTemplate`, and
   `listReportFilter="key"` templates to filter fields (see [§5](#5-templates-content-projection-hooks)).
3. **Permissions**: `canModify` → `effectiveToolbarActions` (hides `requiresFullControl` actions).
4. **Export**: `exportConfig` defaults to enabled when the data source can `fetchAll()` (OData/Views provider) or is
   an array. The file name defaults to the grid title.
5. **Variant bridge** between filter views and grid views ([§6.3](#63-how-the-two-variant-types-are-linked)).
6. **Panel position** for footers: a segmented header action is added automatically. The choice is saved per user under
   `"<tableId>::panelPosition"`.

### 3.3 Filter bar (`beas-header`)

`shared/components/header/header.ts|html`. Used by the list report, and standalone by some screens.

**Rendering**

- Title row: icon + title. When a `filterViewsTableId` is set, the title is replaced by the **filter-view selector**
  (`<beas-view-filters type="title">`).
- Actions toolbar (`actions` input): `button`, `segmented`, `select`.
- Filter row: optional search box (`showSearch`), then `normalFilterFields` (visible, not pinned), then Go / Clear /
  Adapt Filters. A second row shows `pinned` fields (always shown, cannot be hidden with Adapt Filters).
- When collapsed: a summary "Filtered by (n): label: value; …".
- The width of each filter is computed from the row width (`S()` in field-builders: 200–300 px per field, 16 px gap).

**Filter field → form field mapping** (`getFilterFieldConfig`): each filter is rendered with a `beas-form-field`:

- `type: 'date' | 'datetime'` → `type: 'temporal', subtype, range: true` (from/to picker). `time` → temporal, not a range.
- `controlType: 'combobox'` gets `emptyLabel: 'COMMON.ALL'` unless `allowEmpty === false`.
- `cfl` filters (value help) get `mustExist: false` and `multiSelect` turned on by default (`g()`).

**Values**

- `filterValues` is a `linkedSignal` seeded with the default of each field (`p(field)`): `defaultValue`, else
  `false` (checkbox), `null` (combobox/color), `{from:'',to:''}` (date/datetime), or `''`.
- A filter counts as "active" (`D()`) when its value differs from the default and is not empty.
- `updateFilterValue(key, v)` also resets fields that declare `dependsOn: [key]`, then emits `filterChange`.
- **Go** → `onSearch()`. It blurs the focused input, syncs the URL, and emits
  `search({ searchTerm, filterValues: N(visibleFields, values) })`. `N()` normalizes values: times → `HH:mm`,
  CFL multi-select objects → key values (key = `dialogConfig.keyField` or first column), numeric strings → numbers
  (except `UDFn` keys).
- **Clear** resets all values to their defaults and searches again.

**URL sync** (`persistFiltersToUrl`, default on). `R()` serializes each value into a query param:

- ranges → `from~to`
- multi-values → `a,b,c`
- default/empty → param removed

`C()` parses the params back when the page opens. Matching is case-insensitive on the key. If any param matched,
a search runs automatically. In addition, `saveListFiltersGuard` / `restoreListFiltersGuard` store the query string
in `sessionStorage` (`list-filters:<path>`). Coming back from a child route (`/items/123` → `/items`) restores the
last filters.

**Adapt Filters** opens `AdaptFiltersDialog` with `{key,label,selected,type}` items and the default visible keys.
An optional `beforeAdaptFilters` async callback can add more fields first (used by CFL dialogs to add entity fields).
Where the result is saved depends on the mode:

- **Filter-view mode** (`filterViewsTableId` set, which is always the case inside a list report with `tableId`): the
  selection is part of the active filter view and marks it dirty ([§6.2](#62-filter-views-filter-bar-variants)).
- **Legacy mode** (`adaptFiltersPersistKey` set, no table id): the visible keys are saved to `UserGridStates` under that
  key. The entry is deleted when the selection equals the defaults. CFL dialogs use `cfl_<EntitySet>_af`.

### 3.4 Table (`beas-grid`)

`shared/components/grid/grid.ts|html`, built on fundamental-ngx platform `fdp-table`.

**Column processing (`computedColumns`)**

- `dataType` in {date, datetime, quantity, price, time, number, duration} and no `align` → `align: 'end'`.
- Columns with `options` get `filterSelectOptions` (translated labels). `filterOptionReverseMap` maps a label back
  to its value, so the P13 filter dialog shows labels but the query sends values.
- The tree column of `treeMode` is locked (`locked: true`).
- `fdp-column` is rendered with `[visible]="!hidden"`, `[sortable]="sortable !== false"`,
  `[groupable]="groupable === true"`, `[freezable]="true"`, a width (persisted width, else the column width), and a
  filter data type from `Uc[dataType].fdp` (NUMBER / DATE / BOOLEAN / STRING, or `select` if options are present).
  Column-header filtering is disabled (`[filterable]="false"`). Filtering is done in the settings dialog.

**`Uc`: the column data type table.** This table maps grid `dataType` values to fdp column types and OData filter types:

| dataType | fdp type | OData filter type | Display |
|---|---|---|---|
| `price`, `quantity`, `percent`, `rate`, `measure`, `query`, `number` | NUMBER | number | `beasNumber: dataType : decimalsSpec` (+ `suffix`) |
| `currency` | NUMBER | number | `beasCurrency` |
| `minutes` | NUMBER | number | `beasMinutesTime` |
| `duration` | NUMBER | number | `beasNumber:'time'` |
| `color` | NUMBER | number | color swatch |
| `date` / `datetime` | DATE | date / datetime | `beasDate` / `beasDate:true` |
| `time` | STRING | string | `beasTime` |
| `icon` | STRING | string | SAP glyph, Beas icon or custom image |
| `checkbox` | BOOLEAN | boolean | ✓ / – (tristate), or an inline checkbox when editable / `displayAsField` |
| *(none)* | STRING | string | raw value, or a link if `linkConfig` |

**Cell rendering order** (grid.html): `cellTemplate` (or `editCellTemplate` when editable) → checkbox → **editable
editor** (`getEditorKind`: `custom`/`cfl`/`combo`/`date`/`datetime`/`time`/`checkbox`/`icon`/`number`/`text`, each a
`beas-form-field` with `inline: true`) → `options` label → `linkConfig` link → typed formatter (table above) → raw value.
`foreColorKey` sets the text color from a numeric color field on the row.

**Data source handling**

- **Array**: sorting (`currentSortRules`) and filtering (`currentFilterRules`, with the same strategies as the
  P13 dialog) run on the client. Edit mode (`mode='edit'`) is allowed only for arrays. It adds a draft row at the end
  (`edit.autoAddRow`), which becomes a real row on the first edit (`rowAdded`).
- **TableDataSource**: `syncProvider()` pushes column information into the provider:
  - `setColumnDataTypes({key: odataType})` (options → `number`/`string` depending on the value type).
  - `setFilterOptionMap(reverseMap)`.
  - `setSelectFields(selectFields)`: the **`$select` projection** is every column key, plus `foreColorKey`,
    `iconColorKey`, `uomField` and `projection.extraFields`. Excluded: `clientOnly` columns and keys starting with
    `_`. If a view shows a column that was not fetched, `refetchIfProjectionWidened` re-fetches.
  - `setUnusableFilterSink`: when the backend rejects a filter, the grid removes it (`dropUnusableFilters`).

**Toolbar**: title (+ item count), custom `actions`, **grid-view selector** (only with `tableId`), Excel export,
fullscreen, settings.

**Settings dialog** (`GridSettingsDialog`, tabs *columns / sort / filter / group*). Sort, filter and group options are
limited to columns with `sortable !== false`, `filterable !== false`, `groupable === true`. The columns tab shows
`technicalName` and `technicalKindKey` (e.g. "Custom field", "UDF") for metadata-driven columns. A "reset widths" option
restores the column `width`s.

**Export** (`ExcelExportService`): exports the visible, non-locked columns that are not `hideInExport`, using
`exportValueFn(row)` when defined, option labels, and number categories.

### 3.5 Data providers and OData query generation

`shared/o-data-table-data-provider.ts`. Constructor options: `endpoint`, `searchText`, `searchFields`,
`numericSearchFields`, `customFilters`, `defaultFilter`, `defaultOrderBy`, `defaultApply`, `defaultPageSize` (50),
`selectFields`, `columnTypeOverrides`, `transformRow`, `enrichRows`, `onError`.

The list view creates a **new provider on each search** (`dataSource = computed(() => createDataSource(searchText(), filterValues()))`).
The filter bar values become `customFilters`.

`buildODataQuery(tableState)` produces:

| Part | Source |
|---|---|
| `$top`, `$skip` | table page state (skipped by `fetchAll`) |
| `$count=true` | always (total = `@odata.count`, else `X-Total-Count` header, else row count) |
| `$select` | grid projection (disabled when `transformRow` or `defaultApply` is set) |
| `$orderby` | table sort, else `defaultOrderBy` |
| `$filter` | AND of: `defaultFilter`, search, `customFilters`, P13 `filterBy` rules |
| `$apply` | when `defaultApply` is set, filters go into `…/filter(…)` |

- **Search**: `contains(tolower(F),'x')` over `searchFields`, OR `contains(cast(N,'Edm.String'),'x')` over
  `numericSearchFields`. With no search fields it falls back to `Code`/`Description`.
- **customFilters**, by the column's OData type (`columnDataTypes` = grid-derived types + `columnTypeOverrides`):
  - `{from,to}` → `ge`/`le` (Edm date / datetime literal / quoted string)
  - array → `(F eq a or F eq b)` (numbers unquoted)
  - `number` → `eq n`
  - `boolean` → `eq true`
  - `date` → `eq YYYY-MM-DD`
  - `string` → `contains(tolower())`
  - `exact` → `eq 'x'`
  - untyped strings → `contains`
- **P13 filter rules** (`buildP13FilterExpression`): strategies `equalTo/is`, `notEqualTo/isNot`, `greaterThan(OrEqualTo)`,
  `lessThan(OrEqualTo)`, `between`, `contains`, `beginsWith/startsWith`, `endsWith`, `after/before/onOrAfter/onOrBefore`.
  - `exclude` wraps the rule in `not (…)`, or for strings uses a null-safe `indexof` form.
  - `datetime` equality becomes a day range (`ge D and lt D+1`).
- **UDF columns** (`/^UDF\d+$/i`) are stored as strings in the backend. Numbers and dates are compared as quoted
  strings, and booleans as `'1'/'0'`.
- **Error fallbacks**:
  - HTTP 400 with `$select` → retry once without projection.
  - HTTP 400 with P13 filters → return an empty page and report the rejected fields to the grid, which removes them.
  - Other errors → `notifyError` toast (`COMMON.MESSAGES.LOAD_LIST_ERROR`) and an empty result.
- `enrichRows(rows)` runs after fetching. This is how custom-field values are merged in ([§7.2](#72-custom-fields-apisystemcustomfields)).

`shared/views-table-data-provider.ts` is the non-OData version. It POSTs
`{ page, maxToShow, sort:[{selector,desc}], filter:[{selector,value,value2,strategy,exclude}], ...extraBody }`
and reads `{ results, totalCount }`. The full response is available in `metadata()` for KPI/cockpit use.

---

## 4. Object Page

`shared/components/object-page/object-page.ts|html`

### 4.1 Inputs / outputs

| Input | Default | Meaning |
|---|---|---|
| `data` | `null` | The loaded record. Copied into the editable `formData` (`linkedSignal`). |
| `sections` (required) | | Section tree ([§4.4](#44-section-model-sections--groups--subsections--fields)). |
| `headerConfig` (required) | | Header config ([§9.5](#95-object-page-header-config)). |
| `metadataEntity` | `''` | Entity name for `/api/metadata/{metadataEntity}` field constraints ([§7.1](#71-field-constraints-apimetadataentity)). |
| `customFieldEntityName` | `''` | Entity name for custom fields. Adds a "Custom fields" section automatically ([§7.2](#72-custom-fields-apisystemcustomfields)). |
| `isNew` | `false` | Create mode: starts in edit mode and shows the create buttons. |
| `readonly` | `false` | Hides Edit/New/Delete. Also forced when the user lacks `F` on `permissionResource`. |
| `permissionResource` | `''` | Permission key. |
| `entityName` | `'Item'` | Translation key of the entity name (title, messages). |
| `primaryKeyField`, `primaryKeyValue` | | |
| `hideDelete`, `hideNew`, `hideBackButton` | `false` | |
| `customActions` | `[]` | Header toolbar actions with `onClick(formData)`, `visible`, `disabled(formData, isFormValid)`, `showInMode`. |
| `sidePanel` | `null` | Side panel config (opens in a splitter, only outside edit mode). |
| `createButtonLabel`, `singleCreateAction`, `saveVariants` | | Create footer variants ([§6.5](#65-object-page-variants)). |
| `customValidator` | `null` | `async (formData) => boolean`, runs after field validation. |
| `loading`, `notFound` | | |

Outputs: `save({data, isNew, originalData, createAction, saveVariant, customFieldValues})`, `delete`, `cancel`,
`afterCancel({isNew})`, `back`, `refresh`, `navigateFirst/Previous/Next/Last`, `editModeChange`,
`fieldChange({field, value, previousValue, formData})`, `validationChange`, `cflRowSelect`, `fieldPressEnter`.

Public methods used by features through `viewChild(ObjectPage)`: `exitEditMode()`, `resetEditState()`,
`reportSaveFailed(err)`, `setFieldError()`, `getFieldError()`, `validateFields()`, `validateCflFields()`,
`markExternalDirty(source, dirty)`, `scrollToSection()`.

### 4.2 Composition

```
app-object-page
 ├─ (not found)  beas-view-message
 └─ div.object-page
     ├─ [loading overlay]
     ├─ beas-splitter (only when sidePanel is used)
     │   ├─ pageHeader + pageContent
     │   └─ beas-side-panel
     ├─ pageHeader  = app-object-page-header
     └─ pageContent = main#contentArea (scroll container)
          ├─ div#formSections
          │    └─ app-object-page-section × visibleSections()
          └─ footer (floating bar, edit mode only): Save / Update / Create split-button + Cancel
```

Providers per instance: `FormValidationService` and `ConstraintsStore`. Each object page has its own validation
state and its own constraint map. Nested `beas-form-field`s inject the constraint map ([§7.1](#71-field-constraints-apimetadataentity)).

`resolvedSections = rg(sections, constraints)` + the custom-field section (`id: 'custom-fields'`, appended unless the
feature already declares a section with that id). `visibleSections` filters by `section.visible`, which can be a boolean
or `(formData, isEditMode, isNew) => boolean`.

`SectionScrollSpy` tracks the section/subsection currently in view to highlight the header tabs. Clicking a tab
expands that section/subsection and scrolls to it.

### 4.3 Object page header (`app-object-page-header`)

Everything here comes from `headerConfig` plus `formData`/`data`:

- **Navigation row**: refresh, first/prev/next/last (emitted, handled by `BaseDetailView`), breadcrumb.
- **Avatar**: `avatarImage(formData)` URL or `avatarGlyph` (string or function) + `avatarGlyphFont`, `avatarColor`
  (accent, default 6). Size `l`, or `s` when collapsed.
- **Title**: create mode → `createTitle` or "Create {entity}". Otherwise `entityName` + `formData[titleField]`.
- **Subtitle**: create mode → `createSubtitle`. Otherwise `subtitleFormatter(formData)`, or `subtitleFields` joined
  with `subtitleSeparator` (`' | '`).
- **Toolbar** (overflowing):
  - Edit / New / Delete: view mode and not readonly. `hideNew` / `hideDelete` hide New / Delete.
  - `headerButtons`: the leading run of `requiresFullControl` buttons are "standard" buttons. A separator follows,
    then the remaining "extra" buttons.
  - `customActions`.
  - `headerMenus`: dropdowns `{id,label,icon,items:[{label,icon,action(data),visible,disabled,disabledHint}]}`.
  - Side-panel toggle.
- **Secondary row**: `secondaryActions`.
- **Facets** (KPI strip): `{label, field, type?, format?, …}`.
  - `type: 'status'` → `fd-object-status` using `statusMapping[value] = {status, indicationColor, icon}`.
  - `type: 'numeric'` → number formatted with display settings (`decimal`, `decimalCategory`, `unit`, `unitField`,
    `currencyCode`, `format: 'currency'|'percent'`).
  - `format: 'date' | 'datetime' | (v, row) => string`, `suffix` / `suffixField`, `visible(data)`.
- **Tabs**: `fdp-icon-tab-bar` built from `visibleSections` (label/id) with subsections as sub-items.
- Collapse button (hides facets, shrinks avatar).

### 4.4 Section model: sections → groups / subsections → fields

A section can hold fields in three ways, rendered in this order: direct `fields`, then `groups`, then `subsections`.

```ts
Section {
  id, label, icon, iconFont?, description?, cssClass?,
  visible?: boolean | (formData, isEditMode, isNew) => boolean,
  actions?: [{ id, label, glyph, type, onClick(formData), visible, disabled, showInMode: 'view'|'edit', requiresFullControl }],
  customTemplate?: TemplateRef,            // replaces the whole content
  fields: Field[],                         // flat grid of fields
  groups?: Group[],                        // titled field groups laid out in a grid
  subsections?: Subsection[],              // collapsible sub-blocks (shown as sub-tabs)
}
Group      { id, label?, description?, colspan?, fields: Field[], customTemplate? }
Subsection { id, label, collapsible? (default true), initiallyCollapsed?, groups: Group[], customTemplate? }
```

**Field kinds** inside any `fields` array:

| Kind | Marker | Rendering |
|---|---|---|
| Spacer | `type: 'spacer'` | empty grid cell (`colspan` / `cssClass`) |
| Inline field group | `controlType: 'fieldGroup'`, `fields: […]` | one label, several controls side by side. Example from items: `Valid` checkbox + `ActiveFrom` + `ActiveTo`, where the dates use `visible: (d) => isYes(d.Valid)` |
| Custom cell | `cellTemplate` or a `formField="key"` template | projected template |
| Field with action | `onAction(formData)`, `actionIcon`, `actionLabel`, `actionVisible(formData)` | form field + trailing button (shown only when the field has a value by default) |
| Normal field | anything else | `beas-form-field` with `colspan` 1 or 2 |

**Field state rules** (`ObjectPageSection`):

- `visible`: boolean or `(formData, isEditMode, isNew)`. Groups with no visible fields are hidden, unless they have a
  custom template.
- **Editable** = `isEditMode && (editableOnCreate ? isNew : !readonly)`. A field marked `readonly: true,
  editableOnCreate: true` (e.g. `ItemCode`, `Series`) can be edited only while creating.
- `disabled`: boolean or `(formData, isEditMode, isNew)`.
- `required`: boolean or `(formData) => boolean` (dynamic required).
- `onChange(value, formData)` runs in `ObjectPage.updateField`. It can modify `formData` directly (e.g. choosing an
  automatic series clears `ItemCode`).
- `onBlur(value, formData)` runs on focus-out.

### 4.5 Object page section rendering (`app-object-page-section`)

```
fd-card.form-section#<section.id>
  h5  collapse ▸/▾ · icon · label · [section actions]
  div.section-content
     [description]
     IF section.customTemplate OR formSection="<id>" template → render it with context
     ELSE
        div.form-grid   → fieldTpl for each visible field
        div.form-grid   → groupTpl for each group
        for each subsection → collapsible header + (custom template | form-grid of groupTpl)
groupTpl:  div.form-field-group.group-colspan-N → title, description, (custom template | fieldTpl × fields)
fieldTpl:  spacer | fieldGroup | custom cell | field+action | beas-form-field
```

Field events go up to the object page: `valueChange` → `fieldChange{key,value}` → `ObjectPage.updateField`;
`rowSelect` → `cflRowSelect`; `existenceError` → `fieldError` (set as a validation error); `checkStarted` (async
CFL existence check registered as pending); `pressEnter`; `fieldBlur`.

### 4.6 Form field (`beas-form-field`)

`shared/components/form-field/form-field.ts|html`. The **same component** renders object page fields, filter bar
fields, inline grid editors and dialog fields.

- `resolvedField = ii(field, constraintsStore.constraints())`: the field merged with backend constraints, when a
  `ConstraintsStore` is present in the injector tree ([§7.1](#71-field-constraints-apimetadataentity)).
- Label (when `inlineLabel`), with a required marker and `hint` as inline help.
- Error message popover (hover) or max-length warning, shown only in edit mode.
- Control selection:

| `controlType` | Component |
|---|---|
| `checkbox` | `beas-checkbox-field` (`checkboxFormat`: `yesNo` Y/N, `oneZero`, `boolean`; `tristate`) |
| `combobox` | `beas-combobox-field` (`options` array or `(formData) => options`, `allowEmpty`, `emptyLabel`, `emptyOptionValue`) |
| `icon-picker` | `beas-icon-field` (`iconSources: {sap, beas, custom}`) |
| `image` | `beas-image-field` (`imageSource`) |
| `attachment` | `beas-attachment-field` |
| `color-picker` | `beas-color-field` |
| *(default)* + `cfl` | `beas-cfl-field` (value help, existence check, `link`, `maxLength`) |
| *(default)* + `type: 'temporal'` | `beas-temporal-field` (`subtype: date/datetime/time`, `range`) |
| *(default)* | `beas-text-field` (`type: text/number/textarea/password…`, `numberFormat`, `displayFormat`, `decimalPlaces`, `truncate`, `currencyCode`, `uom`, `commitOn`, `textareaHeight`, `iconEnd`, `placeholder`, `validators.maxLength`) |

### 4.7 Edit / create / save lifecycle

```
            data() changes ─────────────► formData = {...data}
                 │  (same key & editing & not dirty → exit edit; different key while editing → reset)
   [Edit] ───► editBaseline = {...formData}; isEditMode = true
                 │
   field edit ─► updateField(key,v): formData[key]=v; dirty=true; field.onChange(); fieldChange.emit();
                 │                    validateField(key) (+ re-check all fields with dynamic `required`)
   [Save] ───► onSave():
                 1. validateFormAsync(): wait for pending CFL checks, probe CFL existence for changed cfl fields,
                    validateForm(), plus validateCflCells() of every projected beas-grid
                 2. customValidator(formData)
                 3. (create) activeSaveVariant.confirm → confirm dialog
                 4. split formData into entityData + customFieldValues (keys known to the custom-field config)
                 5. save.emit({...}); savePending = true
   feature ──► service.create/update → saveCustomFields(…) → toast → reload / navigateAfterCreate(createAction, key)
                 on error: objectPage.reportSaveFailed(err) → maps server field errors; returns true if mapped
   [Cancel] ─► if dirty: "discard?" box → restore editBaseline (edit) or cancel.emit() (create → back to list)
```

- **Create mode**: `isNew` forces edit mode. The footer offers:
  - a **split button** "Add and view / Add and new / Add and back" (`createActions`). The last choice is stored in
    `localStorage['beas.createSaveAction.<permissionResource|entityName>']`, and `BaseDetailView.navigateAfterCreate`
    acts on it;
  - or `singleCreateAction`;
  - or `saveVariants` ([§6.5](#65-object-page-variants)).
- **Dirty tracking** (`DirtyTracker`): form dirtiness plus "external" sources that features set with
  `markExternalDirty(source, bool)`, e.g. sub-grids edited inside a section template. Unsaved changes trigger a
  `beforeunload` prompt and the route guard.
- **Delete**: confirmation using `formData[titleField]`, then `delete.emit()`.
- **Custom field values** are loaded after `data` arrives (`loadCustomFieldValues`) and merged into `data` and `formData`.

### 4.8 Validation

`core/services/form-validation-service.ts` (one instance per object page / dialog).

- `allFields()` flattens sections (fields, inline groups, groups, subsections), skips spacers, and adds the fields of
  any `beas-form-field` projected inside templates (`projectedFields`). Custom section templates are therefore
  validated too.
- `getFieldValidationError(field, value)` checks, in order:
  - `required` (boolean or function) → `VALIDATION.REQUIRED`
  - `validators.min/max` → `VALIDATION.MIN/MAX`
  - `maxDecimals` → `WHOLE_NUMBER` / `MAX_DECIMALS`
  - `minLength/maxLength` → `MIN_LENGTH/MAX_LENGTH`
  - `pattern` → `INVALID_FORMAT`
  - `custom(value, formData)`
- `validateForm()` on an existing record skips fields whose value did not change from the edit baseline, unless their
  `required` is dynamic. Legacy data that breaks a rule therefore does not block saving unrelated changes.
- Read-only fields and `editableOnCreate` fields on existing records are never validated.
- CFL fields with `mustExist !== false` are checked against the backend (`CflExistenceService`, by `keyField`).

Many of these `validators` / `required` values are **not written by the feature**. They come from metadata
([§7.1](#71-field-constraints-apimetadataentity)).

---

## 5. Templates (content projection hooks)

All hooks are `ng-template` directives that the shells collect with `contentChildren`.

| Directive | Selector / key | Collected by | Replaces | Template context |
|---|---|---|---|---|
| `ListReportCellDirective` | `listReportCell="ColumnName"` (matches `column.name`) | ListReport → `column.cellTemplate` | grid cell display | `$implicit: row`, `column` |
| `ListReportFilterDirective` | `listReportFilter="filterKey"` | ListReport → `filterField.cellTemplate` | filter control | `$implicit: value`, `setValue(v)` |
| `ListReportFooterDirective` | `listReportFooter` | ListReport | adds a footer pane (splitter with positions left/top/bottom/right/hide) | none |
| `FormSectionDirective` | `formSection="sectionId"` | ObjectPage → Section | whole section content | `$implicit: formData`, `isEditMode`, `isNew`, `updateField(key, value)` |
| `FormGroupTemplateDirective` | `formGroupTemplate="groupId"` | ObjectPage → Section | group content (title/description still shown) | same as section |
| `FormSubsectionTemplateDirective` | `formSubsectionTemplate="subsectionId"` | ObjectPage → Section | subsection content | same as section |
| `FormFieldDirective` | `formField="fieldKey"` | ObjectPage → Section | one field cell | `$implicit: value`, `field`, `formData`, `isEditMode`, `isNew`, `isEditable`, `updateField`, `error` |

The same replacement can also be set inside the config: `section.customTemplate`, `group.customTemplate`,
`subsection.customTemplate`, `field.cellTemplate`, `column.cellTemplate`, `column.editCellTemplate`.

**What templates are used for**: the layout stays declarative, and complex parts are placed where they belong.

- `item-view.html`: `formGroupTemplate="inventory-warehouses"` puts a `beas-grid` of item warehouses inside the
  inventory group.
- `resource-view.html`: `formSection="scheduling" | "cost" | "documents" | "downtime" | …` contain calendars, KPI
  layouts and sub-grids. They render `beas-form-field`s manually and call `updateField`. Those fields are still validated
  because ObjectPage collects projected `FormField`s and `Grid`s.
- `resources-view.html`: `listReportCell` for computed status/utilization columns, and `listReportFooter` for a cockpit
  with tiles and charts under the grid.

---

## 6. Variants (saved views)

There are **two independent variant systems**, both stored by the backend `GridViews` controller, plus a link
between them.

> **Naming caveat (reconstruction).** In this tree the class named `FilterViewsService` is the one `beas-grid` uses for
> **grid** views (`tableId` as is), and the class named `GridViewsService` is the one `beas-header` uses for **filter**
> views (`tableId + '::filters'`). Their roles look swapped compared to their names. The names were assigned during
> reconstruction. The descriptions below follow behaviour, not class names.

Common view object (`toView()`):

```ts
{ id, tableId, name, ownerCode,
  visibility: 'Personal' | 'Shared' | 'System',
  isDefault, canEdit, state /* parsed StateJson */, modified }
```

Backend API (`<apiRest>/api/system/GridViews`):

| Call | HTTP |
|---|---|
| list | `GET ?tableId=<id>` |
| create | `POST {TableId, Name, Visibility, StateJson}` |
| update | `PUT /by-id?id=<id> {Name?, Visibility?, StateJson?}` |
| delete | `DELETE /by-id?id=<id>` |

The **active view id** is not stored with the views. It is per-user state in `UserGridStates`
(`GET|PUT /api/system/UserGridStates/by-key?key=<userCode>|<key>`) under the key `"<tableId>::activeView"` (grid) or
`"<tableId>::filters::activeView"` (filters).

**System views** (`ks(tableId, systemViews)` in `breadcrumb.ts`) turn feature-declared `{ key, name, state }` entries
into read-only views with `id: 'system:<key>'`, `visibility: 'System'`, `canEdit: false`. A **"Standard"** view
(`key: 'default'`, `name: 'BEAS_GRID.VIEWS.STANDARD'`, `state: null`, `isDefault: true`) is always added first,
unless the feature declares its own `default`.

**Selector UI** (`beas-view-filters`, `view-filters.ts|html`): a menu listing System → Personal → Shared views (with an
icon per visibility), and:

- **Save**: only if `canEdit`.
- **Save as**: `ViewSaveDialog`, name + visibility. Shared requires permission `grid-shared-views` with level `F`.
- **Rename / Delete**: only if `canEdit`.
- **Restore**: system views only, when dirty.

A dirty view shows `*` after its name. `type="title"` displays it as the page title (filter views).
`type="toolbar"` displays it as a grid toolbar button (grid views).

### 6.1 Grid views (table variants)

Enabled by `[persistence]="{tableId}"` (the list report passes its `tableId`). Implemented in `grid.ts`.

**State payload** (`capturePayload`):

```ts
{
  columns: string[],            // visible column names, in order
  columnKeys: string[],
  sortBy:  [{ field, direction }],
  filterBy:[{ field, strategy, value, value2, exclude }],   // dates normalized for storage
  groupBy: [{ field, direction, showAsColumn }],
  freezeToColumn: string | null,
  columnWidths?: { [columnName]: '123px' },
  knownColumns: string[],       // every column that existed when the view was saved
}
```

**Loading** (`viewsResource` → `mergedViews` → `applyActiveView`):

1. `forkJoin(listViews(tableId), getActiveViewId(tableId))`.
2. `views = [...systemViews, ...saved]`. The active view is the stored id, else the default, else the first view.
3. `applyViewState(view)`:
   - `state` null → **defaults**: columns with `hidden !== true`, no sort/filter/group/freeze, default widths.
   - otherwise `applyState(state)`:
     - Columns: `qc(state.columns, state.knownColumns, computedColumns, canEdit)` merges columns added to the feature
       after the view was saved. A non-hidden column that is not in `knownColumns` is inserted next to its neighbour
       from the feature's column order. `_actions` is always removed.
     - Filters: `applicableFilters()` drops rules for columns that no longer exist, are `filterable: false`, or were
       rejected by the backend.
     - Then sort, group, freeze. Widths come from `persistedColumnWidths`.

**Dirty detection**: every table change (`presetChanged`, `columnsChange`, `filterChange`, `groupChange`, column
resize) compares `presetSignature(current)` with the signature of the active view's state. A view becomes dirty only if
it is editable (`canEdit`) or is a system view (which can then be *restored*). Resizing a column also marks it dirty.

**Actions**:

| Action | Behaviour |
|---|---|
| Select | applies the view state and stores the active id |
| Save | `updateView(id, {payload})` |
| Save as | `createView` and make the new view active |
| Rename | `updateView(id, {name, visibility})` |
| Delete | switch to default/first view |
| Restore | re-apply the system view state |

The grid emits `activeViewChange`, which the list report uses for linking ([§6.3](#63-how-the-two-variant-types-are-linked)).

**Example system grid view** (`resources-view.ts`):

```ts
systemViews = [{ key: 'by-group', name: 'MASTER_DATA.RESOURCES.VIEW_BY_GROUP',
  state: { columns: [], columnKeys: [], sortBy: [], filterBy: [],
           groupBy: [{ field: 'Group', direction: 'asc', showAsColumn: false }], freezeToColumn: null } }];
```

(`columns: []` means "use the default visible columns".)

### 6.2 Filter views (filter-bar variants)

Enabled when `beas-header` receives `filterViewsTableId` (the list report passes `tableId`). The backend `tableId` is
`"<tableId>::filters"`.

**State payload** (`snapshotFilterState`):

```ts
{
  adaptFilterKeys: string[],   // visible (non-pinned) filters, in order — the "Adapt Filters" layout
  filterValues: { [key]: any },
  searchTerm: string,
  gridViewId: string | null,   // linked grid view (see 6.3)
}
```

**Loading**: after first render, `forkJoin(listViews, getActiveViewId)` (5 s timeout, falls back to empty), then
`views = [...systemFilterViews, ...saved]`, the active view is selected, and `tryApplyFilterView()` runs.

`applyFilterViewState(view, applyValues, userInitiated, isRestore)`:

1. Filter layout: `adaptFilterKeys`, or the defaults captured from the feature's `filterFields` (`defaultVisibleKeys`).
2. Values: defaults overwritten by `state.filterValues`, restricted to known keys (`M()`), plus `searchTerm`. The values
   are **not** applied when the URL already has filter params, so the URL wins on first load.
3. Records a saved-signature baseline and emits `filterViewBaselined`.
4. Emits `applyGridView(state.gridViewId)` when the view links a grid view, or when the user switched views (an empty
   id selects the default grid view).
5. Runs a search if values were applied and the user switched views or some filter is active.

**Dirty**: `JSON(filterSignatureState) !== lastSavedSignature`, OR the linked grid view was changed by the user
(`gridViewChanged`). Only for views that are editable or system views.

**Example system filter view** (`warehouses-view.ts`):

```ts
systemFilterViews = [{ key: 'external-warehouses', name: 'MASTER_DATA.WAREHOUSES.VIEW_EXTERNAL',
  state: { adaptFilterKeys: ['Locked','Inactive','Country','BeasLocked'],
           filterValues: { BeasLocked: 'E' }, searchTerm: '' } }];
```

### 6.3 How the two variant types are linked

A filter view can carry a grid view, so one choice in the page title restores both the filters and the table layout.

```
beas-header ──applyGridView(id)──► ListReport.onApplyGridView(id) ──► grid.selectViewById(id)
     ▲                                   │  expectedGridViewIds = {current, id}
     │                                   ▼
     │  [linkedGridViewId]     grid ──activeViewChange(view)──► ListReport.onGridActiveViewChange
     │  [gridViewChanged]            activeGridViewId = view.id
     └─────────────────────────────  gridViewChangedByUser = id ∉ expectedGridViewIds
```

- **Saving a filter view** stores `gridViewId = linkedGridViewId` (the grid view active now).
- **Selecting a filter view** switches the grid to its stored grid view (or the default one).
  `selectViewById` waits (`pendingViewSelection`) if grid views have not loaded yet.
- If the user then picks a different grid view, the filter view becomes dirty.
- After saving or applying, `filterViewBaselined` resets the expected set, so the current grid view counts as
  "not changed".

Example (`resources-view.ts`): the system filter view `by-group` has `gridViewId: 'system:by-group'`. Choosing it in
the title also switches the grid to the grouped layout.

### 6.4 Other per-user persistence

| What | Where | Key |
|---|---|---|
| Active grid view | `UserGridStates` | `<userCode>\|<tableId>::activeView` |
| Active filter view | `UserGridStates` | `<userCode>\|<tableId>::filters::activeView` |
| Footer panel position | `UserGridStates` | `<userCode>\|<tableId>::panelPosition` → `{position}` |
| Adapt-filter layout (only without filter views, e.g. CFL dialogs) | `UserGridStates` | `<userCode>\|<adaptFiltersPersistKey>` → `string[]` |
| CFL dialog grid | grid views | `cfl_<EntitySet>_g` (table id) |
| Last list query string | `sessionStorage` | `list-filters:<path>` |
| Object page create action | `localStorage` | `beas.createSaveAction.<resource>` |

`GridStateService.resetAllStates()` deletes all `UserGridStates` of the user (user settings).

### 6.5 Object Page "variants"

The object page has no saved layout variants. Its variant concepts are:

- **Save variants** (`saveVariants` input, create mode). Entries `{ id, label, glyph?, disabled?(formData), confirm?: {title, message} }`.
  - With more than one variant, a split button with a radio-style menu is shown.
  - The chosen id is emitted as `save.saveVariant`, and the feature decides what to create.
  - `confirm` shows a confirmation box first.
- **Create actions** (default, when there are no save variants and `singleCreateAction` is false): view / new / back
  after create, remembered per entity ([§4.7](#47-edit--create--save-lifecycle)).
- **Conditional layout**: sections, fields, groups and actions with `visible` / `disabled` / `required` functions of
  `(formData, isEditMode, isNew)` give different layouts for different record states (e.g. type-dependent sections).

---

## 7. Entity metadata: where it comes from and how it shapes the UI

### 7.1 Field constraints (`/api/metadata/{Entity}`)

**Fetching**: `FieldConstraintsService.get(entity)` (`core/services/field-constraints-service.ts`):

- `GET <host>/api/metadata/<Entity>`, cached per entity with `shareReplay(1)`.
- On error it returns `{}` and, in dev mode, warns: *"no field constraints for entity … check the [metadataEntity] key"*.
- The entity name is the **backend entity set name**, usually plural PascalCase: `'Items'`, `'Warehouses'`,
  `'Resources'`, `'ItemMaterials'`, `'ItemRoutings'`, `'WorkOrderRoutings'`, `'InterruptionReasons'`,
  `'ShortVariants'`.

**Response shape** (inferred from use):

```jsonc
{
  "ItemCode": { "MaxLength": 50, "Required": true, "Type": "string" },
  "ItemName": { "MaxLength": 200 },
  "Quantity": { "Min": 0, "Scale": 6, "Type": "number" },
  "Code":     { "Pattern": "^[A-Z0-9]+$", "MinLength": 2 }
  // keys: entity property names; values: MaxLength, MinLength, Min, Max, Scale, Pattern, Required, Type
}
```

**Applying constraints.** The main function is `ii(field, constraints)` in `form-field.ts`, with helpers `Jo` and `Zo`:

1. `Jo(field.key, constraints)` finds the metadata entry. It tries an exact match first, then a case-insensitive
   match (a lower-case key map is cached per constraints object in a `WeakMap`).
2. `Zo(field, entry, metaKey)` returns a **new field** (or the same object if nothing changes):

| Metadata | Field effect |
|---|---|
| `MaxLength` | `validators.maxLength`. The text/CFL field shows a "max length reached" warning, and validation fails above it. |
| `MinLength` | `validators.minLength` |
| `Min` / `Max` | `validators.min` / `validators.max` |
| `Scale` | `validators.maxDecimals` (0 → "whole number") |
| `Pattern` | `validators.pattern` (regex string) |
| `Required: true` | `required: true`, **unless** the feature set `required` to a function (dynamic rules always win). Shows the required asterisk and the `VALIDATION.REQUIRED` check. |
| key casing differs | `key` is **rewritten to the metadata casing** (e.g. feature `itemcode` → `ItemCode`), so `formData[key]` reads the real property. |

Feature-declared validators are kept. Metadata validators are merged on top (`{...field.validators, ...meta}`).

**Where `ii` is applied:**

| Path | Mechanism |
|---|---|
| Object page sections | `resolvedSections = rg(sections(), constraints())`. `rg` goes through `section.fields`, `section.groups[].fields` and `section.subsections[].groups[].fields`, including the children of `fieldGroup`s (spacers skipped), and **replaces fields in place**. So `FormValidationService` (which reads `resolvedSections`) validates with the metadata rules. |
| Every `beas-form-field` under an object page | `ObjectPage` sets `ConstraintsStore.constraints` (component-level provider). `FormField.resolvedField = ii(field, store.constraints())`. This covers fields rendered by hand inside `formSection` / `formGroupTemplate` templates and inline grid editors inside the page. `ObjectPage.projectedFields` reads `resolvedField()`, so those fields are validated with the same rules. |
| Detail views that build sections themselves | e.g. `item-bom-detail-view`, `item-routing-detail-view`, `wo-*-detail-view`: `constraints = toSignal(fieldConstraints.get('ItemMaterials'))`, `sections = rg([...base, udfSection], constraints())`. Some also read constraints directly (`constraints().AlternativeMaterial?.MaxLength`). |
| Dialogs | `ObjectDialog` has its own `metadataEntity` input with the same mechanism. `RoutingPositionEditDialogBase` uses `og(fields, constraints)`, the flat-list variant of `rg`, per routing position kind. |
| CFL value-help dialogs | `CflDialog` loads `fieldConstraints.get(entitySet)` and uses each `Type` to choose OData filter types (`inferredFieldTypes`). The entity set is `config.metadataEntity` or the last segment of the endpoint. |

**What metadata does NOT do**: it does not create fields, choose control types, labels, sections or columns, or set
visibility. Those all come from the feature config. The list report/grid does not use `/api/metadata` at all. Column
OData types come from the column `dataType` plus `columnTypeOverrides`.

### 7.2 Custom fields (`/api/system/CustomFields`)

Admin-configurable extra fields per entity, set up in `features/custom-fields`. They can be own DB columns, related
(navigation) fields, formulas, or code-provided values.

**Config**: `CustomFieldService.getConfig(entity)` → `GET /api/system/CustomFields/entity/<Entity>`, cached in a
signal and cleared on company change. Each row:

```ts
{ FieldName, Label, DataType /* text|number|decimal|date|datetime|checkbox|boolean */,
  Visible /* 1 = list column */, VisibleInEditView /* 1 = form field */, Editable /* 1 */,
  SourceKind /* 'OwnColumn' | 'Related' | 'Formula' | 'CodeProvider' */, MaxLength }
```

**List Report effect** (`BaseListView` + `getCustomColumns`):

- Rows with `Visible === 1` become columns: `name/key = FieldName`, `label`, `width: 120px`, `clientOnly: true`
  (**excluded from `$select`**), `technicalName`, and `technicalKindKey` (custom / related / formula, shown in the
  settings dialog).
- Data type mapping: `date` → `date`, `datetime` → `datetime`, `number` → `quantity` with 0 decimals,
  `decimal` → `quantity`, `checkbox`/`boolean` → `checkbox`.
- `CodeProvider` fields are not sortable or filterable.
- The feature appends them: `columns = [...baseColumns, ...this.customColumns()]`. Because they are columns, they are
  also available as hidden filters (filter pool) and in grid views.
- **Values** are not in the OData response. `enrichRows` → `CustomFieldService.mergeValues` → `POST
  /api/system/CustomFields/values/<Entity> {Keys, Fields}` returns `{ [rowKey]: {field: value} }`, which is assigned
  onto the rows. The row key comes from `extractKey(row)`.
- When the set of custom field names changes (e.g. config loads after the first fetch), `BaseListView` calls
  `refreshDataSource()`.

**Object Page effect** (`customFieldEntityName` input):

- `getCustomFieldFormFields(entity)`: rows with `VisibleInEditView === 1` → `buildFormField`:
  - `readonly` unless `SourceKind === 'OwnColumn' && Editable === 1`;
  - `number`/`decimal` → text field with an integer/decimal regex validator (`maxLength: 50`);
  - `date`/`datetime` → temporal;
  - `checkbox` → checkbox `oneZero`; `boolean` → checkbox `boolean`;
  - text → `validators.maxLength = MaxLength`.
- These fields form an automatic section `{ id: 'custom-fields', label: 'COMMON.SECTIONS.CUSTOM_FIELDS', icon: 'form' }`
  appended to `resolvedSections`, so it also appears as a header tab.
- **Load**: `getRecordValues(entity, data)`:
  1. builds the record key from `GET …/entity/<Entity>/keyFields` (case-insensitive property lookup on the record);
  2. `POST …/record/<Entity> {Key}`;
  3. merges the values into `data` and `formData`.
- **Save**: `ObjectPage.onSave` removes all custom-field keys (`getRecordFieldNames`: config + keys seen in loaded
  records) from the payload into `customFieldValues`. The entity `PUT`/`POST` therefore never contains them. The
  feature then calls `BaseDetailView.saveCustomFields(record, customFieldValues)` → `PUT …/record/<Entity> {Key, Values}`,
  sending only editable `OwnColumn` fields.

### 7.3 UDFs (`/api/system/UdfConfigs`)

Labels and visibility for the fixed `UDF1…UDFn` columns of Beas tables. Served by `UdfConfigService` →
`GET /api/system/UdfConfigs/entity/<Entity>`, rows `{FieldName: 'UDF3', Label, DataType, Visible, VisibleInEditView, Editable}`.

- **Columns** (`getUdfColumns`): like custom-field columns, but `technicalKindKey = FIELD_KIND_UDF`, they are real
  OData columns (sortable, filterable, included in `$select`), and checkbox UDFs get Y/N `options`.
- **Form section** (`getUdfFormSection(entity, n)`): fields `UDF1..UDFn` with `VisibleInEditView === 1`, typed by
  `DataType`:
  - `number`/`decimal` → `type: 'number'`. Its `onChange` stores the value back as a string, because UDFs are string
    columns.
  - `checkbox` → `yesNo`.
  - text → `maxLength 50`.

  The **custom fields of the same entity are appended** to it, and the result is returned as one `custom-fields`
  section. Example: `ItemView` uses `getUdfFormSection('Item', 0)` (custom fields only) and appends it to its sections
  when it is not empty. Detail views such as BOM and routing use `getUdfFormSection(…, 15)`.
- **Filtering**: `ODataTableDataProvider.isUdfField` → number/date/boolean values are compared as quoted strings, and
  booleans as `'1'/'0'`. The filter-bar normalizer `N()` does not turn `UDFn` values into numbers.

### 7.4 Server-side validation errors

`ObjectPage.reportSaveFailed(httpError)` (called by features in their `error:` handler) puts the page back in edit
mode and maps server errors onto fields:

- Beas format `error.Error.Fields: [{Field, MaxLength}]` → `VALIDATION.MAX_LENGTH` on that field.
- ASP.NET model-state format `error.errors: { Field: ["msg"] }` → `localizeServerError`. It prefers the local
  validation message for the current value. Otherwise it uses the server message with the property name replaced by the
  translated label.

It returns `true` when at least one field error was mapped. Otherwise the feature shows a generic error box.

### 7.5 Runtime type inference

When no metadata is available, some components infer types from data:

- `CflDialog.inferFieldType(value)` → number / boolean / date (ISO-like string) / string. It reads the first row
  (`$top=1`) to list the entity's fields, and adds them as hidden columns and adapt-filter candidates
  (`extendedColumns`).
- `ODataTableDataProvider.buildP13FilterExpression` falls back to the JS type of the filter value when the column type
  is unknown.

---

## 8. End-to-end flows

### List page load and search

```
ItemsView ctor
  ├─ columns = te(t) + customColumns()          (custom-field config fetched → signal)
  ├─ filterFields = ae(t, host)                 (explicit filters)
  └─ dataSource = TableDataSource(ODataTableDataProvider{endpoint:/Items, searchFields, customFilters:{}, enrichRows})
ListReport
  ├─ buildPool(filterFields, columns)           → explicit + hidden column-derived filters
  ├─ beas-header (tableId 'items')
  │    ├─ load filter views ('items::filters') + active id → apply adaptFilterKeys / values
  │    ├─ (or) restore ?query params → values → onSearch()
  │    └─ emit applyGridView(gridViewId?)
  └─ beas-grid (tableId 'items')
       ├─ load grid views ('items') + active id → applyViewState (columns/sort/filter/group/widths)
       ├─ syncProvider: column OData types, option map, $select projection
       └─ fdp-table → provider.fetch(state) → GET /Items?$top&$skip&$count&$select&$orderby&$filter
                                              → enrichRows → POST CustomFields/values/Item
User presses Go
  header.onSearch → URL sync → search{searchTerm, filterValues}
  ItemsView.onSearch → searchText/filterValues signals → new provider → grid fetches page 1
User changes columns/sort/filter in settings → grid view dirty "*" → Save / Save as
```

### Detail page load, edit and save

```
ItemView (route :id) → itemResource GET /Items('X') → item() (+ derived props)
ObjectPage
  ├─ constraints ← GET /api/metadata/Items  (cached) → ConstraintsStore + rg(sections)
  ├─ custom-field section ← CustomFields config ; values ← POST CustomFields/record/Item
  ├─ header: titleField/subtitle/avatar/facets/headerButtons ; tabs ← visibleSections
  └─ sections → groups → beas-form-field (resolvedField = field ⊕ constraints)
Edit → baseline → edits (onChange, validateField) → Save
  → validateFormAsync (+CFL existence, +projected grids) → customValidator
  → save.emit({data (without custom fields), customFieldValues, createAction, …})
ItemView.onSave → PUT /Items('X') → saveCustomFields → PUT CustomFields/record/Item → toast → reload
       error → objectPage.reportSaveFailed(err) → server field errors shown inline
```

---

## 9. Configuration reference

The shapes below were collected from what the components read. All label-like strings go through the `translate`
pipe, so they can be translation keys or already-translated text.

### 9.1 Grid column

| Property | Used by | Notes |
|---|---|---|
| `name` | grid | Column id (fdp `name`). Used for views, widths, `listReportCell`. |
| `key` | grid, provider | Row property. Used for `$select`, sort/filter field. |
| `label` | grid | |
| `width` | grid | default width (also restored by "reset widths") |
| `align` | grid | `start` / `center` / `end` (auto `end` for numeric/date types) |
| `hidden` | grid, views | Not visible by default (available in column settings). |
| `sortable` | grid | `false` disables sorting |
| `filterable` | list report, grid, settings | `false`: no auto filter and no P13 filter |
| `groupable` | grid, settings | `true` to allow grouping |
| `dataType` | grid, provider, export, filter pool | see the `Uc` table |
| `decimalPlaces`, `uomField`, `uom`, `suffix` | grid | number formatting |
| `options: [{value,label}]` | grid, filter pool, export | value → label display, select filter |
| `linkConfig: {route?, idField?, action?(id,row)}` | grid | navigation link cell |
| `foreColorKey`, `iconColorKey` | grid | row-driven colors (added to `$select`) |
| `cellTemplate`, `editCellTemplate` | grid | custom rendering |
| `editable`, `editableWhen(row)`, `validate(v,row)`, `editOptions(row)`, `editEmptyLabel(row)`, `cflConfig` | grid edit mode | |
| `displayAsField`, `tristate` | grid | checkbox rendering |
| `clientOnly` | grid projection | not sent in `$select` (custom fields, computed columns) |
| `locked` | grid | not exportable; tree column |
| `hideInExport`, `exportValueFn(row)` | export | |
| `technicalName`, `technicalKindKey` | settings dialog | metadata-driven columns |

### 9.2 Filter field

| Property | Notes |
|---|---|
| `key`, `label`, `placeholder`, `width` | `key` = OData property (becomes a `customFilters` key) |
| `type` | `text` (default), `number`, `date`, `datetime` (rendered as ranges), `time` |
| `controlType` | `combobox`, `checkbox`, `color-picker`, … |
| `options` (array or function), `allowEmpty`, `emptyLabel` | combobox |
| `cfl: { dialogConfig, … }` | value help; multi-select by default |
| `visible` | `false` = hidden by default (can be enabled in Adapt Filters) |
| `pinned` | always visible, in a separate row |
| `defaultValue` | initial value and "Clear" target |
| `dependsOn: string[]` | reset when one of these filters changes |
| `readonly`, `disabled` | |
| `numberFormat`, `decimalPlaces`, `uom` | auto-derived number filters |
| `cellTemplate` | from `listReportFilter` |

### 9.3 Form field (object page)

`key`, `label`, `hint`, `placeholder`, `type` (`text`/`number`/`textarea`/`temporal`/`spacer`/`checkbox`), `subtype`,
`range`, `controlType` (`checkbox`/`combobox`/`icon-picker`/`image`/`attachment`/`color-picker`/`fieldGroup`),
`fields` (fieldGroup children), `options`, `allowEmpty`, `emptyLabel`, `emptyOptionValue`, `checkboxFormat`,
`checkboxLabel`, `tristate`, `cfl`, `link`, `numberFormat`, `displayFormat`, `decimalPlaces`, `truncate`,
`currencyCode`, `uom`, `textareaHeight`, `textareaResizable`, `commitOn`, `iconEnd`, `iconSources`, `imageSource`,
`colspan` (1|2), `cssClass`, `readonly`, `editableOnCreate`, `disabled`, `visible`, `required`,
`validators {required?, min, max, minLength, maxLength, maxDecimals, pattern, custom(v, formData)}`,
`onChange(v, formData)`, `onBlur(v, formData)`, `onAction`, `actionIcon`, `actionLabel`, `actionVisible`,
`cellTemplate`.

### 9.4 Section / group / subsection

See [§4.4](#44-section-model-sections--groups--subsections--fields).

### 9.5 Object page header config

| Property | Notes |
|---|---|
| `titleField` | record id shown in the title; also used in the delete confirmation |
| `keyField` | detects "a different record was loaded" (defaults to `titleField`) |
| `subtitleFields`, `subtitleSeparator`, `subtitleFormatter(row)` | |
| `createTitle`, `createSubtitle` | create mode |
| `avatarGlyph` (string \| fn), `avatarGlyphFont` (string \| fn), `avatarImage(row)`, `avatarColor` | |
| `facets[]` | `{label, field, type?: 'status'\|'numeric', format?: 'date'\|'datetime'\|'currency'\|'percent'\|fn, statusMapping, suffix, suffixField, unit, unitField, currencyCode, decimal, decimalCategory, visible(row)}` |
| `headerButtons[]` | `{id, label, icon, iconFont, type, action(data), visible, disabled, requiresFullControl}` |
| `headerMenus[]` | `{id, label, icon, iconFont, items[], visible, requiresFullControl}` |
| `secondaryActions[]` | like header buttons, plus `disabledHint` |

### 9.6 List report header / grid config

- **Header**: `title`, `icon`, `iconFont`, `showSearch` (default on), `searchPlaceholder`, `showAdaptFilters`
  (default on), `showFilterActions` (default on), `filterBarExpanded`.
- **Grid**: `title`, `selectionMode`, `showNavigationColumn`, `activeRow`, `emptyMessage`,
  `projection {enabled, extraFields}`, `virtualScroll`, `pageScrolling`, `pageSize` (default: system setup
  `tablePageSize`), `contentDensity`, `exportConfig {enabled, filename, exportDataFn}`, `hideItemCount`, `rowClass(row)`.

---

## 10. File index

| Area | Files |
|---|---|
| List report | `src/app/shared/components/list-report/*` |
| Filter bar | `src/app/shared/components/header/*`, `src/app/shared/cfl/field-builders.ts`, `src/app/shared/components/adapt-filters-dialog/*` |
| Grid | `src/app/shared/components/grid/*`, `src/app/shared/components/grid-settings-dialog/*`, `src/app/shared/table-dialog-patcher.ts`, `src/app/shared/tree-table-state.ts` |
| Data providers | `src/app/shared/o-data-table-data-provider.ts`, `src/app/shared/views-table-data-provider.ts` |
| Variants | `src/app/shared/components/view-filters/*`, `src/app/shared/components/view-save-dialog/*`, `src/app/core/services/filter-views-service.ts` (grid views), `src/app/core/services/grid-views-service.ts` (filter views), `src/app/core/services/grid-state-service.ts`, system views `ks()/eo()` in `src/app/shared/components/breadcrumb/breadcrumb.ts` |
| Object page | `src/app/shared/components/object-page/*`, `object-page-header/*`, `object-page-section/*`, `side-panel/*`, `src/app/shared/section-scroll-spy.ts`, `src/app/shared/dirty-tracker.ts` |
| Form fields | `src/app/shared/components/form-field/*` (+ `text-field`, `temporal-field`, `cfl-field`, `combobox-field`, `checkbox-field`, `icon-field`, `image-field`, `attachment-field`, `color-field`) |
| Templates | `src/app/shared/directives/list-report-*-directive.ts`, `form-section-directive.ts`, `form-group-template-directive.ts`, `form-subsection-template-directive.ts`, `form-field-directive.ts` |
| Base classes | `src/app/shared/directives/base-list-view.ts`, `base-detail-view.ts`, `src/app/shared/base-crud-service.ts` |
| Metadata | `src/app/core/services/field-constraints-service.ts`, `constraints-store.ts`, `rg()/og()` in `src/main.ts`, `ii()/Jo()/Zo()` in `form-field.ts`, `form-validation-service.ts` |
| Custom fields / UDFs | `src/app/core/services/custom-field-service.ts`, `custom-fields-api-service.ts`, `udf-config-service.ts`, `udf-configs-api-service.ts` |
| Routing helpers | `src/app/core/guards/create-mode.match.ts`, `list-filters.guard.ts`, `unsaved-changes.guard.ts`, `entity-not-found-resolver.ts` |
| Example features | `features/warehouses/*` (read-only list + detail, system filter view), `features/items/*` (CRUD, groups, inline field groups, custom fields, group template), `features/resources/*` (system grid + filter views linked, footer cockpit, section templates) |
