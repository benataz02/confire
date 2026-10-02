# Value help (CFL) and key-field navigation in the beas web client

Covers how a field or grid column that holds the **key of another entity** gets a value help to pick it,
existence validation, auto-fill of dependent fields, and a link that opens that entity's detail page.

> The source was reconstructed from minified bundles and has no types (see `README.md`). The interfaces
> below were inferred from how the properties are read. File references point at the reconstructed tree.

---

## 1. Vocabulary and building blocks

The code calls a value help a **CFL ("Choose From List")**, the SAP Business One term for it.

| Piece | File | Role |
|---|---|---|
| `CflField` (`<beas-cfl-field>`) | `src/app/shared/components/cfl-field/cfl-field.ts` | Input with type-ahead suggestions, a value-help button (`glyph="value-help"`), a clear button, tokens for multi-select, an existence check and an optional navigation link. |
| `CflDialog` (`<beas-cfl-dialog>`) | `src/app/shared/components/cfl-dialog/cfl-dialog.ts` | Full search dialog: header search, "Adapt filters", paged OData grid, single/multi select. |
| `FormField` (`<beas-form-field>`) | `src/app/shared/components/form-field/form-field.ts/.html` | Generic field. It renders `<beas-cfl-field>` when the field definition has a `cfl` property. |
| `cfl-configs.ts` | `src/app/shared/cfl/cfl-configs.ts` | Dialog-config factories for master data (material groups, raw materials, warehouses, UoM, …) plus the item filter-field/column definitions. |
| `CflConfigsService` | `src/app/core/services/cfl-configs-service.ts` | Root service with one factory per entity (`resources()`, `warehouses()`, `glAccounts()`, …). It injects the API host. |
| `CflExistenceService` | `src/app/core/services/cfl-existence-service.ts` | Checks that a typed key exists (`exists`) or loads its row (`findRow`). Results are cached. |
| `FormValidationService` | `src/app/core/services/form-validation-service.ts` | Object-page validation. Waits for pending CFL checks and re-checks changed CFL fields before save. |
| Helpers in `src/main.ts` | `wu`, `Su`, `Du` | `wu`: do all values exist? `Su`: find the row for a value. `Du`: turn an error descriptor into a translated message. |
| `nr$1` in `cfl-field.ts` | | Builds the "not found" error descriptor. |
| `encodeODataKey` in `cfl-field.ts` | | `encodeURIComponent(value.replace(/'/g,"''"))`, used for OData string literals in URLs. |
| `NavigationService` | `src/app/core/services/navigation-service.ts` | `navigate([route, key])`. Trims string segments and adds the `/views` prefix when the app runs in "views" mode. |
| `Grid` (`<beas-grid>`) | `src/app/shared/components/grid/grid.ts/.html` | Columns with `linkConfig` render as links. Editable columns with `cflConfig` render a CFL editor. |
| `ODataTableDataProvider` | `src/app/shared/o-data-table-data-provider.ts` | Builds `$filter/$top/$skip/$orderby` for the dialog grid and for list reports. |

---

## 2. The configuration model

There are two layers. A field definition carries a **`cfl` wrapper**, and the wrapper holds a **`dialogConfig`**.

```ts
// Inferred shapes, not present in the source.
interface CflFieldConfig {
  dialogConfig: CflDialogConfig;
  searchEndpoint?: string;      // overrides dialogConfig.endpoint for type-ahead and existence probes
  mustExist?: boolean;          // default true. The filter bar forces false.
}

interface CflDialogConfig {
  title: string;                // i18n key, e.g. 'COMMON.FIELDS.WAREHOUSE'. Also names the entity in "X not found".
  endpoint: string;             // OData collection, e.g. `${host}/api/bsl/Warehouses` (may carry ?query params)
  columns: GridColumn[];        // dialog grid and suggestion popover columns
  searchFields: string[];       // string fields matched by the search text
  numericSearchFields?: string[];// numeric fields matched via cast(x,'Edm.String')

  keyField?: string;            // the key that is stored. Default: columns[0].key
  displayField?: string;        // token label in multi-select (default keyField)
  displayColumns?: string[];    // single select: show "col1  col2" instead of the raw key

  route?: string;               // detail route of the entity, used by `link: true`
  onRowNavigate?: (row) => void;// in the dialog, clicking a selected row again navigates instead of selecting
  readOnly?: boolean;           // dialog has no Select button (browse only)
  multiSelect?: boolean;        // tokens and checkbox selection

  defaultFilter?: string;       // raw OData filter ANDed into every query (search, probe, label lookup)
  defaultApply?: string;        // OData $apply (disables paging/$count)
  fixedFilters?: Record<string, any>;            // fixed equality/contains filters in the dialog only
  filterFields?: FilterField[];                  // dialog header filters (may contain nested cfl)
  excludeAdaptFilters?: string[];                // fields hidden from "Adapt filters"
  transformFilterValues?: (v) => v;              // e.g. items: ManagedBy -> ManageBatchNumbers/ManageSerialNumbers
  showAdaptFilters?: boolean;                    // default true
  udfEntityName?: string;                        // load UDF labels for adapt filters
  metadataEntity?: string;                       // entity-set name if the endpoint is not /EntitySet
}
```

### Key field resolution

Everything that needs "the key" uses the same rule:

```ts
const keyField = dialogConfig.keyField ?? dialogConfig.columns[0]?.key;
```

The key field is used for:
- the value stored when a row is picked (`row[keyField]`, trimmed),
- the existence probe and the label lookup (`$filter=<keyField> eq '<value>'`),
- duplicate detection between multi-select tokens,
- turning multi-select filter tokens into `Key eq 'A' or Key eq 'B'` and into URL params.

So **the first column must be the key, unless `keyField` says otherwise.** Examples that set `keyField`
because the stored value differs from what users see:

| Config | keyField | displayField / displayColumns | Why |
|---|---|---|---|
| `glAccounts` | `AcctCode` | `FormatCode`, `['FormatCode','AcctName']` | Stores the internal account code and shows the formatted code plus name. |
| `businessPlaces` | `BranchId` (numeric) | `BranchName` | |
| `workOrderTasks` | `Prjuid` | `Task`, `['Prjuid','Task','Description']` | |
| `sapUsers` | `UserName` | | The first column is `UserCode`, but the name is stored. |
| `beasJournals` | `DocEntry` | `DocNum` | |
| `priceLists` | `ListNum` | `ListName` | |

### Where configs come from

```ts
// core/services/cfl-configs-service.ts
@Injectable({ providedIn: 'root' })
export class CflConfigsService {
  host = inject(ConfigService).host;
  resources       = (overrides) => i(this.host(), overrides);        // route: '/resources'
  warehouses      = (overrides) => o(this.host(), overrides);
  unitsOfMeasure  = (itemCode, overrides) => I(this.host(), itemCode, overrides);
  binLocations    = (whsCode, overrides) => y(this.host(), whsCode, overrides);
  itemVersions    = (itemCode, overrides) => q(this.host(), itemCode, overrides);
  // … one per entity
}
```

Each factory returns a literal and spreads `...overrides` last, so call sites adjust behaviour:

```ts
this.cfl.resources({ multiSelect: true });
this.cfl.qcGroups({ onRowNavigate: (row) => this.router.navigate(['/qc-groups', row.Code]) });
```

**Context-dependent value helps** take the parent key and put it in `defaultFilter`, quoted with
`o()` (`'` → `''`). They often add a hidden, disabled filter field so the dialog header shows the restriction:

```ts
// binLocations(whsCode)
defaultFilter: `WhsCode eq '${o(whsCode)}' and Active eq 'Y'`,
filterFields: [{ key: 'WhsCode', label: 'COMMON.FIELDS.WAREHOUSE', visible: false, disabled: true, defaultValue: whsCode }],

// unitsOfMeasure(itemCode): query parameter instead of a filter
endpoint: itemCode ? `${host}/api/bsl/UnitsOfMeasure?itemCode=${encodeURIComponent(itemCode)}` : `${host}/api/bsl/UnitsOfMeasure`,
defaultFilter: "Locked ne 'Y'",
```

Query parameters on `endpoint` are kept. The type-ahead and label lookup append `&$top…`, and the
existence probe copies them into its `HttpParams`.

---

## 3. `CflField`: behaviour in detail

### Inputs and outputs

| Input | Meaning |
|---|---|
| `config` (required) | `CflFieldConfig` |
| `value` | Current key (single) or array of row objects (multi) |
| `editable`, `disabled`, `placeholder`, `ariaLabel`, `maxLength`, `error` | Usual field state |
| `link` | `true` or `{ route?, idField?, action? }`. See section 7. |
| `formData` | The whole record. Needed for `link.idField` and `link.action`. |
| `mustExist` | Overrides `config.mustExist` |

| Output | Emitted when |
|---|---|
| `valueChange(key \| rows[] \| null)` | Typing (single, non-label mode), picking, clearing, adding/removing tokens |
| `rowSelect(row)` | A row was picked from suggestions or the dialog (single select only) |
| `existenceError(descriptor \| null)` | After a probe. `null` means OK. |
| `checkStarted(promise)` | A probe started, so forms can wait for it before saving |
| `pressEnter()` | Enter/Tab without an open suggestion |
| `maxLengthWarningChange(bool)` | Typing reached `maxLength` |

### Type-ahead

1. Every keystroke (length ≥ 1) is pushed to `search$`, which is debounced by **200 ms**.
2. The request:
   ```
   GET {searchEndpoint ?? endpoint}?$top=10&$count=true&$filter=
       (<defaultFilter>) and (
         startswith(tolower(Code),'abc') or startswith(tolower(Description),'abc')
         [or startswith(cast(DocNum,'Edm.String'),'abc')]   // numericSearchFields
       )
   ```
   The type-ahead uses **`startswith`**. The dialog's search uses **`contains`** (see section 4).
3. Stale responses are discarded. Each request gets a sequence number (`requestSeq`). A response is
   ignored if it is not the latest, if the input has lost focus (`leftInput`), or if the text has changed since.
4. The popover shows a table with the non-hidden `columns`. If the user customised the dialog grid,
   it shows those columns in that order instead: both read the persisted state `cfl_<EntitySet>_g` from
   `GridStateService`. `dataType: 'icon'` cells render beas/SAP/custom icons. `foreColorKey` colours
   the text through a contrast-adjusted colour (`Ua()`).
5. Footer: "N results" and **Show all**, which opens the dialog.
6. Keyboard: `↓/↑` move the highlight (wrapping), `Enter`/`Tab` pick the highlighted row, `Esc` closes.
   With nothing highlighted, `Enter`/`Tab` close the popover, run the existence check and emit `pressEnter`.

### Single select

- **Plain mode** (no `displayColumns`): the input shows the raw key, and every keystroke emits `valueChange(text)`.
- **Label mode** (`displayColumns` set): while not focused the input shows `"FormatCode  AcctName"`.
  On focus it clears to a search box. Typing searches but does **not** change the value. Only picking a row does.
  When the value changes from outside, the label is fetched once:
  ```
  GET {endpoint}?$top=1&$select=<keyField>,<displayColumns…>&$filter=<keyField> eq '<value>'
  ```
  It is cached per key in `resolvedRows`.
- Picking a row: `valueChange(trim(row[keyField]))`, then `rowSelect(row)`, then `markValueKnown()`.
  `markValueKnown()` writes "exists" into the existence cache, so no probe follows.
- On blur, string values are trimmed, and the trimmed value is emitted if it differs.

### Multi select (`dialogConfig.multiSelect: true`)

- The value is an **array of row objects** shown as `fd-token`s. The label is
  `row[displayField ?? keyField]`.
- Typed text that is not picked becomes a free token `{ [keyField]: text }` on blur, Enter or Tab.
  Tab picks the first suggestion if there is one.
- Duplicates are skipped by comparing `keyField`.
- "Show all" passes the current typed text to the dialog as its initial search.

### Existence check (validation)

```
existenceRequired = mustExist input ?? config.mustExist ?? true
```

It runs on blur, Enter, Tab and token changes. It skips values that were already checked or are empty.

```ts
// CflExistenceService.paramsFor
$filter = (defaultFilter) and <keyField> eq '<value>'   // numbers are not quoted
$top    = 1
+ every query param that was already on the endpoint URL
GET endpoint-without-query
→ exists = response.value.length > 0
```

- Results are cached by `endpoint|keyField|value|defaultFilter` and evicted oldest-first at 500 entries.
- **A failed request counts as "exists"** (`console.warn` and `of(true)`), so a backend problem never
  blocks the user.
- If the value does not exist, the component remembers it as `missingValue` and **hides the navigation
  link**. It emits:
  ```ts
  { key: 'COMMON.ERRORS.ENTITY_NOT_FOUND', entityKey: dialogConfig.title }
  ```
  `Du()` translates this. It first tries `title` with `.TITLE` replaced by `.ENTITY_NAME`, then the title
  itself, which gives for example "Material group not found". Without a title the message is
  `COMMON.ERRORS.ENTRY_NOT_FOUND` ("Entry not found").
- The probe promise is emitted through `checkStarted`, and `whenValidated()` returns it.

### Save-time validation

| Host | Mechanism |
|---|---|
| Object page | `FormValidationService.registerPendingCheck(promise)`. `validateFormAsync()` waits until no checks are pending, then calls `probeCflFields()`. That re-probes every editable field with `cfl` and `mustExist !== false` **whose value differs from the loaded baseline**, using `wu()`. |
| Object dialog | `trackCheck()` / `attemptSave()` / `validateCflValues()` do the same, for all editable CFL fields. |
| Editable grid | `validateCflCells()` groups rows by cell value, probes each distinct value once with `wu()`, and marks every affected cell. |

---

## 4. `CflDialog`: the full value help

Open it with `CflDialog.open(dialogService, dialogConfig, initialSearchText?)`. The size is 1600×900
(max 95vw × 90vh), or full-screen on mobile (`Qa()`). `CflField` imports it lazily
(`await import('../cfl-dialog/cfl-dialog')`).

**Columns.** The dialog sends `GET endpoint?$top=1` and reads the keys of the first row to find the
entity's fields. `FieldConstraintsService.get(entitySet)` supplies their types. Fields not already in
`columns` are appended as **hidden** columns, so users can show them through grid settings. Their labels
come from `humanizeFieldName()`, which tries these translation keys in order:
`MASTER_DATA.<UDF_ENTITY>S.<FIELD>`, `COMMON.FIELDS.<FIELD>`, the same keys without an `_ID` suffix,
and finally a spaced-out version of the field name.

**Filters.** The header search and filter bar (`<beas-header>`) feed an `ODataTableDataProvider`:

```ts
new ODataTableDataProvider(http, {
  endpoint, searchText, searchFields, numericSearchFields,
  customFilters: transformFilterValues?.({ ...fixedFilters, ...nonEmptyAppliedFilters }),
  defaultFilter, defaultApply, defaultPageSize: 50,
  columnTypeOverrides,                           // from column dataType / filter field type / inferred types
});
```

The search text is matched with `contains(tolower(f),'x')` on `searchFields` and with
`contains(cast(f,'Edm.String'),'x')` on `numericSearchFields`. Grid paging is virtual and loads 50 rows
per page.

"Adapt filters" offers every entity field except `excludeAdaptFilters`. Booleans become Yes/No
comboboxes, and numbers and dates get typed inputs. The adapt-filter state is persisted under
`cfl_<EntitySet>_af`, and the grid layout under `cfl_<EntitySet>_g`.

**Selection.**

| Mode | Interaction |
|---|---|
| Single (default) | The first click on a row highlights it. Clicking the **same** row again selects it, like "Select". The dialog closes with the row object. |
| `multiSelect` | Checkbox selection. The button reads "Select (n)". The dialog closes with an array of rows. |
| `readOnly` | No Select button. Browse only. |
| `onRowNavigate` | First click highlights. Clicking the same row again **dismisses the dialog and calls `onRowNavigate(row)`**. |

---

## 5. Using a CFL in object pages and object dialogs

Add `cfl` to a field definition. `FormField` renders a `<beas-cfl-field>` for it and forwards the events:

```
beas-cfl-field ─rowSelect────────▶ beas-form-field ─rowSelect─▶ object-page-section ─cflRowSelect {field,row}─▶ ObjectPage ─(cflRowSelect)─▶ your view
               ─existenceError───▶                  ─existenceError─▶                 ─fieldError─▶ validation.setFieldError
               ─checkStarted─────▶                  ─checkStarted──▶                  ─fieldCheckStarted─▶ validation.registerPendingCheck
```

`FormField` also merges backend constraints (`ConstraintsStore`, which provides `MaxLength`, `Required`, …)
into the field. `validators.maxLength` then reaches `CflField.maxLength`.

### Filling dependent fields when a row is picked

**Object page:** handle `(cflRowSelect)` and copy values with `objectPage().updateField()`:

```ts
// features/internal-maintenances/internal-maintenance-view.ts
onCflRowSelect(e) {
  const page = this.objectPage();
  if (!page || !e.row) return;
  switch (e.field) {
    case 'ItemCode':
      page.updateField('ItemName', e.row.ItemName ?? null);
      break;
    case 'BaseLineNum':
      page.updateField('ItemCode', e.row.ItemCode ?? null);
      page.updateField('ItemName', e.row.ItemName ?? null);
      break;
  }
}
```

**Object dialog:** put `onRowSelect(row, draft)` on the field definition and mutate the draft:

```ts
{
  key: 'ToolCode', label: '…', cfl: { dialogConfig: this.cfl.tools() },
  onRowSelect: (row, draft) => { draft.ToolDescription = row.Description; },
}
```

In the object dialog, `onRowSelect` also runs when the user **types** a key and leaves the field.
`commitField()` → `resolveRow()` → `Su()` → `CflExistenceService.findRow()` loads the row and calls the
same hook. Typed and picked values therefore fill the same dependent fields.

---

## 6. Using a CFL in filter bars (list reports)

```ts
filterFields = LanguageSignals.computed(this.languageService, () => [
  {
    key: 'ResourceId',
    label: this.translateService.instant('MASTER_DATA.OPERATION_CATALOGS.RESOURCE_ID'),
    cfl: { dialogConfig: this.cfl.resources({ multiSelect: true }) },
  },
]);
```

What `Header.getFilterFieldConfig()` changes for filter fields:
- It forces `mustExist: false`, so filters never show "not found".
- `dialogConfig.multiSelect` becomes `true` **unless it is explicitly `false`** (`g()` in
  `field-builders.ts`).

How the values flow (`field-builders.ts`):
- `N()`: tokens (row objects) become plain key values: `[{Code:'R1'},{Code:'R2'}]` → `['R1','R2']`.
  For `type: 'number'` (non-UDF) fields the values are converted to numbers.
- `ODataTableDataProvider` turns the array into `(ResourceId eq 'R1' or ResourceId eq 'R2')`.
- `R()` writes the URL `?ResourceId=R1,R2`. `C()` reads it back as `[{Code:'R1'},{Code:'R2'}]`.

The shorthand builder is `createFieldBuilders(translate).lookup(key, labelKey, dialogConfig, visible?)`.

---

## 7. Key-field navigation ("link to the entity")

A column or field that holds the key of another entity can navigate to that entity's detail page. Every
variant follows the same route convention: **the detail route is `<listRoute>/<key>`**, e.g.
`/resources/R100`. Navigation always goes through
`NavigationService.navigate([route, keyValue])`. That method trims string segments and rewrites
`/x` to `/views/x` when the current URL is under `/views`, so links stay inside the embedded "views" shell.

All variants show the same visual cue: an `navigation-right-arrow` icon before the value.

### 7a. CFL form fields: `link: true | LinkConfig`

```ts
interface LinkConfig {
  route?: string;                            // default for CFL fields: dialogConfig.route
  idField?: string;                          // read the key from formData[idField] instead of the field value
  action?: (value, formData) => void;        // custom handler, takes precedence over route
}
```

`CflField` logic:

```ts
linkConfig = computed(() => (this.link() === true ? {} : this.link() || {}));
linkValue  = computed(() => {
  const { idField } = this.linkConfig();
  const v = idField ? this.formData()[idField] : this.value();
  return v == null ? '' : String(v).trim();
});
showLink = computed(() =>
  !!this.link() &&
  (!!linkConfig.action || !!(linkConfig.route ?? this.config().dialogConfig.route)) &&
  !!this.linkValue() &&
  this.value() !== this.missingValue()        // hidden while the value is known NOT to exist
);
onLinkClick(ev) {
  ev.stopPropagation();
  if (cfg.action) return cfg.action(this.value(), this.formData());
  this.navigation.navigate([cfg.route ?? this.config().dialogConfig.route, this.linkValue()]);
}
```

Rendering:
- **Read-only:** the value, or the composed label in label mode, becomes `<a class="cfl-link">` with
  the arrow. It works with mouse and with Enter.
- **Edit mode:** an arrow add-on is shown **before** the input (`cfl-link-addon`), so the user can open
  the referenced record while editing.
- Multi-select fields never show a link. They render read-only tokens instead.

`link: true` works only if the dialog config has a `route`. Configs that define one:

| Factory | route |
|---|---|
| `resources` | `/resources` |
| `operationTypes` | `/operation-types` |
| `operationCatalogs` | `/operation-catalogs` |
| `qcGroups` | `/qc-groups` |
| `qcTemplates` | `/qc-templates` |
| `maintenanceStatuses` | `/maintenance-statuses` |

For any other entity, use `link: { route: '/…' }` or add `route` through the overrides:
`this.cfl.warehouses({ route: '/warehouses' })`.

### 7b. Plain (non-CFL) text fields: `link: { route | action, idField? }`

`TextField` supports the same `LinkConfig` with two differences:
- **The object form is required.** `link: true` has no effect because there is no `dialogConfig.route`
  to fall back on.
- The link renders **only in read-only mode** (`<a class="field-link">`).

```ts
// features/resource-groups/resource-group-view.ts
placeholderCodeField = { key: 'PlaceholderCode', label: '…', readonly: true, link: { route: '/resources' } };
```

### 7c. Grid / list-report columns: `linkConfig`

```ts
{ name: 'ResourceId', key: 'ResourceId', label: '…', width: '120px', filterable: false,
  linkConfig: { route: '/resources' } }
```

`grid.html` renders a link (`<a class="beas-grid-link">`) only when all of these hold:
- the cell is **not** in edit mode,
- the column has no `cellTemplate`, no `options` and **no `dataType`**. Those branches are checked first,
  so for example a numeric `dataType` column never becomes a link,
- the cell value is non-empty after trimming.

```ts
// grid.ts
onLinkClick(column, row) {
  const cfg = column.linkConfig; if (!cfg) return;
  const rec = this.asRecord(row);
  const value = rec[cfg.idField ?? column.key];
  if (cfg.action) { cfg.action(value, rec); return; }
  if (cfg.route && value) this.navigation.navigate([cfg.route, value]);
}
```

The template calls `$event.stopPropagation()`, and the grid's row-click handler ignores clicks inside
`.beas-grid-link`. A link click therefore opens the **referenced** entity, not the row's own record.

`action` covers targets that are not routes or that need more than one key segment:

```ts
// active-work-order-times-view.ts: position link needs DocEntry + PosId
linkConfig: { action: (_value, row) => this.openPosition(row, row.PosId) }

// external-production-view.ts: opens a dialog instead of navigating
linkConfig: { action: (_v, row) => this.openInventoryHistory(String(row.producedItemCode ?? '')) }
```

### 7d. A list row's own key: row navigation

The list's own entity is opened through the navigation column, not through links:

```
gridConfig.showNavigationColumn: true
  → ListReport passes selection.rowNavigatable = true to beas-grid
  → grid (rowNavigate) → ListReport (navigationClick)
  → view: (navigationClick)="onRowClick($event)"
  → BaseListView.onRowClick(row) = navigation.navigate([this.routePath, this.extractKey(row)])
```

Every list view defines `routePath` and `extractKey(row)`, for example `row.Code` or `row.ItemCode`.
`extractKey()` is also used for delete confirmations, delete calls and custom-field merging.

On the detail side, `BaseDetailView` uses `getKey()` and the service's
`getFirstKey/getLastKey/getPreviousKey/getNextKey` for record-to-record navigation, again with
`recordCommands([key]) = [routePath, ...parents, key]`. After a create it navigates to
`[routePath, newKey]`, to the list (`'back'`), or to the list with `#create` (`'new'`).

### 7e. Navigating from inside a value-help dialog

- `dialogConfig.onRowNavigate`: clicking a highlighted row again jumps to the entity instead of selecting
  it. The Select button still works.
- A read-only "where-used" browser built on `CflDialog`:

```ts
// features/material-groups/material-group-view.ts (cross reference)
CflDialog.open(this.dialogService, {
  title: t.instant('MASTER_DATA.MATERIAL_GROUPS.CROSS_REFERENCE_TITLE', { code }),
  endpoint: this.itemsService.getEndpoint(),
  columns: [
    { name: 'ItemCode', key: 'ItemCode', label: t.instant('COMMON.FIELDS.ITEM_CODE'), width: '200px' },
    { name: 'ItemName', key: 'ItemName', label: t.instant('COMMON.FIELDS.ITEM_NAME') },
  ],
  searchFields: ['ItemCode', 'ItemName'],
  fixedFilters: { MaterialGroup: code },
  readOnly: true,
  onRowNavigate: (row) => this.navigation.navigate(['/items', row.ItemCode]),
});
```

---

## 8. Editable grids with a CFL editor

Give the column a `cflConfig`, which is a **dialog config, not the `{dialogConfig}` wrapper**:

```ts
{ name: 'wageType', key: 'wageType', label: '…', width: '200px',
  sortable: false, filterable: false,
  cflConfig: this.cfl.wageTypes() }      // keyField defaults to columns[0] = 'WageType'
```

`getEditorKind()` returns `'cfl'` when there is no `editCellTemplate`. The cell then renders:

```html
<beas-cfl-field [config]="{ dialogConfig: computedColumn.cflConfig }"
                [value]="item[computedColumn.key]" [editable]="true"
                [error]="getCellError(item, computedColumn.key)"
                (valueChange)="onEditorUpdate(item, computedColumn, $event)"
                (existenceError)="onCellExistenceError(item, computedColumn, $event)" />
```

The cell editor gets no `link`, and outside edit mode `linkConfig` only applies when there is no
`dataType`. To get a link in view mode, add `linkConfig` next to `cflConfig`.
Before saving, call `grid.validateCflCells()` (see section 3).

---

## 9. Recipes

These samples are written in the app's patterns. Names that do not exist in the app (`suppliers`,
`ExternalRef`, the work-order position route) are only illustrations.

### 9.1 Add a value help for a new entity

```ts
// core/services/cfl-configs-service.ts
function suppliers(host, overrides) {
  return {
    title: 'MASTER_DATA.SUPPLIERS.TITLE',          // '.TITLE' → '.ENTITY_NAME' for "X not found"
    endpoint: `${host}/api/bsl/BusinessPartners`,
    udfEntityName: 'BusinessPartner',
    route: '/business-partners',                   // enables `link: true`
    keyField: 'CardCode',                          // explicit, although it is also columns[0]
    columns: [
      { name: 'CardCode', key: 'CardCode', label: 'COMMON.FIELDS.BUSINESS_PARTNER_CODE', width: '140px' },
      { name: 'CardName', key: 'CardName', label: 'COMMON.FIELDS.BUSINESS_PARTNER_NAME' },
      { name: 'City',     key: 'City',     label: 'COMMON.FIELDS.CITY', hidden: true },
    ],
    searchFields: ['CardCode', 'CardName'],
    defaultFilter: "CardType eq 'S'",              // applied to search, probe and label lookup
    filterFields: [
      { key: 'CardCode', label: 'COMMON.FIELDS.BUSINESS_PARTNER_CODE' },
      { key: 'CardName', label: 'COMMON.FIELDS.BUSINESS_PARTNER_NAME' },
    ],
    ...overrides,
  };
}
// in the class:
suppliers = (overrides?) => suppliers(this.host(), overrides);
```

### 9.2 Object-page field: value help, validation, link and auto-fill

```ts
// section definition
{
  key: 'CardCode',
  label: t.instant('COMMON.FIELDS.SUPPLIER'),
  type: 'text',
  required: true,
  cfl: { dialogConfig: this.cfl.suppliers() },   // mustExist defaults to true
  link: true,                                     // uses dialogConfig.route
},
{ key: 'CardName', label: t.instant('COMMON.FIELDS.NAME'), type: 'text', readonly: true },
```

```html
<beas-object-page … (cflRowSelect)="onCflRowSelect($event)"></beas-object-page>
```

```ts
onCflRowSelect({ field, row }) {
  if (field === 'CardCode') this.objectPage()?.updateField('CardName', row.CardName ?? null);
}
```

### 9.3 Store an ID, show a name, navigate by ID

```ts
{
  key: 'AcctCode',
  cfl: { dialogConfig: this.cfl.glAccounts() },   // keyField AcctCode, displayColumns FormatCode + AcctName
  // There is no GL-account detail route in the app, so this one gets no link.
  // With a route, `link: { route }` would navigate with AcctCode (the stored value), not the label.
}

// or: a display field whose link uses another field as the key
{ key: 'ResourceName', type: 'text', readonly: true, link: { route: '/resources', idField: 'ResourceId' } }
```

### 9.4 Context-restricted value help that follows another field

```ts
binCfl = computed(() => ({ dialogConfig: this.cfl.binLocations(this.formData().WhsCode) }));
// field: { key: 'BinCode', cfl: this.binCfl(), … }
// The probe, type-ahead and dialog all add: WhsCode eq '<whs>' and Active eq 'Y'
```

### 9.5 Optional (free-text-allowed) CFL

```ts
{ key: 'ExternalRef', cfl: { mustExist: false, dialogConfig: this.cfl.projects() } }
// or per instance: <beas-cfl-field [mustExist]="false" …>
```

### 9.6 Open the dialog yourself and use the result

```ts
const ref = CflDialog.open(this.dialogService, this.cfl.items({ multiSelect: true }), 'A-');
ref.afterClosed.subscribe((rows) => { /* rows: row object[] (single select: one row object) */ });
// CflField itself watches ref.closeResult() for { status: 'closed', value }.
```

### 9.7 Grid column links

```ts
columns = [
  { name: 'ItemCode',  key: 'ItemCode',  label: '…', linkConfig: { route: '/items' } },
  { name: 'CardCode',  key: 'CardCode',  label: '…', linkConfig: { route: '/business-partners' } },
  { name: 'PosLabel',  key: 'PosLabel',  label: '…',
    linkConfig: { action: (_v, row) => this.navigation.navigate(['/work-orders', row.DocEntry, 'positions', row.PosId]) } },
];
```

---

## 10. Gotchas

1. **Column order matters.** Without `keyField`, the first column is the key. If the key column is
   moved or a decorative column is put first, the wrong value is stored and probed. `qcGroups` and
   `qcInspectionPlans` start with `Bitmap`/`ColorId` columns and therefore set `keyField` explicitly.
2. `link: true` on a CFL whose config has no `route` shows nothing. On a non-CFL text field it never
   works. Use `link: { route }` there.
3. Grid `linkConfig` is ignored when the column has `dataType`, `options` or a `cellTemplate`, and in edit mode.
4. The type-ahead matches with `startswith`, the dialog with `contains`. Users may see a value in "Show all"
   that the type-ahead did not offer.
5. A failed existence probe counts as valid. Saving then relies on the backend's own validation.
6. Filter-bar CFLs are multi-select and `mustExist: false` by default. A filter-bar field that should be
   single-select needs `multiSelect: false` explicitly.
7. Multi-select values are row objects, not keys. Convert them with `row[keyField]`, as `N()` does,
   before sending them anywhere other than through the header.
8. Link targets follow `/<route>/<key>`. A composite key needs `action`, because the generic
   `[route, value]` call passes only one segment.
9. `defaultFilter` contains raw OData. Escape interpolated values with `o()` (`'` → `''`), as every
   context-dependent factory does.
