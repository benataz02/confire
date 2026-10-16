import type { ReactNode } from "react";
import type { FilterCond, FilterValue, ViewState } from "@confire/db";
import type { EntityConstraints } from "./metadata.ts";

// The config shapes a feature declares and the two shells read — LIST-REPORT-OBJECT-PAGE.md §9 and
// VALUE-HELP-AND-KEY-NAVIGATION.md §2, typed. A feature writes object literals of these; metadata
// only fills in what a declared entry left out (label, type, options, maxLength, editability).

export type { FilterCond, FilterValue, ListQuery, ObjectViewState, ViewState } from "@confire/db";

export type Row = Record<string, unknown>;

/** What a value is — the metadata `Type`. Decides formatting, the filter control and the editor. */
export type FieldType = "string" | "number" | "boolean" | "date" | "time" | "enum" | "collection";

export type Option = { value: string | number | boolean; label: string };

export type ValueState = "None" | "Positive" | "Critical" | "Negative" | "Information";

/** Key navigation (value-help doc §7): `route` + the value (or `row[idField]`), or an action. */
export type LinkConfig = {
  route?: string;
  idField?: string;
  action?: (value: unknown, row: Row) => void;
};

/** §9.1 grid column. `key` is both the row property and the column id. */
export type ListColumn = {
  key: string;
  label?: string;
  type?: FieldType;
  options?: Option[];
  width?: number;
  /** not visible by default — still offered in the settings dialog and as a hidden filter */
  hidden?: boolean;
  sortable?: boolean;
  /** false: no auto filter in the pool */
  filterable?: boolean;
  /** true: offered in the Group tab, as in Beas */
  groupable?: boolean;
  /** a string filter on this column is `eq`, not `contains` */
  exact?: boolean;
  linkConfig?: LinkConfig;
  // --- edit mode (array data) ---
  readonly?: boolean;
  required?: boolean;
  /** the cell's value help — a dialog config, not the `{dialogConfig}` wrapper (§8) */
  cflConfig?: CflDialogConfig;
  /** a picked value-help row patches the line, e.g. ItemCode fills ItemDescription */
  onRowSelect?: (row: Row) => Row;
  // --- filled from metadata ---
  maxLength?: number;
  /** metadata Editable — the write allowlist reached this column */
  metaEditable?: boolean;
  udf?: boolean;
  /** BoYesNoEnum: the value travels as tYES/tNO */
  yesNo?: boolean;
  /** an Edm integer (a key, document number or code): shown without digit grouping */
  integer?: boolean;
};

/** §9.2 filter field. `key` is the property the filter compiles against. */
export type FilterField = {
  key: string;
  label?: string;
  type?: FieldType;
  options?: Option[];
  exact?: boolean;
  /** false: hidden until Adapt Filters shows it */
  visible?: boolean;
  cfl?: CflFieldConfig;
  /** reset when one of these filters changes */
  dependsOn?: string[];
  defaultValue?: FilterValue;
};

/** Where a value help reads. Beas' `endpoint`, as data: an entity set paged through entities.rows,
 *  or a masterdata query table paged through configs.queryPage. */
export type CflSource =
  | { kind: "entity"; entitySet: string }
  | { kind: "masterdata"; modelId: string; table: string };

/** Value-help doc §2. `keyField ?? columns[0].key` is the key everywhere. */
export type CflDialogConfig = {
  title: string;
  source: CflSource;
  columns: ListColumn[];
  searchFields: string[];
  keyField?: string;
  /** multi-select token label */
  displayField?: string;
  /** single select: show these instead of the raw key ("label mode") */
  displayColumns?: string[];
  /** detail route of the entity — what `link: true` opens */
  route?: string;
  /** in the dialog, clicking a row navigates instead of selecting */
  onRowNavigate?: (row: Row) => void;
  /** browse only: no Select */
  readOnly?: boolean;
  multiSelect?: boolean;
  /** ANDed into every read: search, probe, label lookup. Compiled server-side — no raw OData. */
  fixedFilters?: FilterCond[];
  filterFields?: FilterField[];
  excludeAdaptFilters?: string[];
  showAdaptFilters?: boolean;
};

export type CflFieldConfig = {
  dialogConfig: CflDialogConfig;
  /** overrides `dialogConfig.source` for the type-ahead and the existence probe */
  searchEndpoint?: CflSource;
  /** default true; filter bars force false */
  mustExist?: boolean;
};

/** A rule that may depend on the record being edited. */
export type Dyn<T> = T | ((formData: Row, isEditMode: boolean, isNew: boolean) => T);

/** §9.3 form field. */
export type FormField = {
  key: string;
  label?: string;
  type?: FieldType;
  options?: Option[];
  colspan?: 1 | 2;
  readonly?: boolean;
  /** editable only while creating (with `readonly`, Beas' ItemCode pattern) */
  editableOnCreate?: boolean;
  required?: Dyn<boolean>;
  visible?: Dyn<boolean>;
  disabled?: Dyn<boolean>;
  validators?: {
    maxLength?: number;
    min?: number;
    max?: number;
    pattern?: string;
    custom?: (value: unknown, formData: Row) => string | null;
  };
  /** runs in updateField; what it returns is merged into the record too */
  onChange?: (value: unknown, formData: Row) => Row | void;
  controlType?: "textarea" | "checkbox" | "combobox" | "fieldGroup";
  /** fieldGroup children: one label, several controls */
  fields?: FormField[];
  cfl?: CflFieldConfig;
  /** a picked (or typed-and-found) value-help row patches the record, e.g. CardCode fills CardName */
  onRowSelect?: (row: Row) => Row;
  link?: true | LinkConfig;
  // --- filled from metadata ---
  udf?: boolean;
  yesNo?: boolean;
  integer?: boolean;
  metaEditable?: boolean;
  metaRequired?: boolean;
};

export type Group = { id: string; label?: string; fields: FormField[] };
export type Subsection = { id: string; label: string; groups: Group[] };

/** §4.4. A section holds fields, groups, subsections — or one collection as a grid. */
export type Section = {
  id: string;
  label: string;
  visible?: Dyn<boolean>;
  fields?: FormField[];
  groups?: Group[];
  subsections?: Subsection[];
  table?: { key: string; columns: ListColumn[] };
};

export type Facet = {
  field: string;
  label?: string;
  type: "status" | "numeric" | "date";
  statusMapping?: Record<string, { state: ValueState; text?: string }>;
  /** a numeric facet's unit, read off the record (DocTotal's DocCurrency) */
  unitField?: string;
};

export type HeaderActionContext = {
  formData: Row;
  isEditMode: boolean;
  isNew: boolean;
  constraints: EntityConstraints | undefined;
};

/** §9.5. */
export type HeaderConfig = {
  titleField: string;
  subtitleFields?: string[];
  createTitle?: string;
  facets?: Facet[];
  actions?: (ctx: HeaderActionContext) => ReactNode;
};

/** A view a feature declares in code (Beas `systemViews`). `state: null` = the declared defaults;
 *  a partial state overrides only what it names. Key `default` replaces Standard. */
export type SystemView<S> = { key: string; name: string; state: Partial<S> | null; isDefault?: boolean };

/** A declared list — the XxxView of a Beas feature. */
export type ListFeature = {
  tableId: string;
  title: string;
  columns: ListColumn[];
  filterFields?: FilterField[];
  systemViews?: SystemView<ViewState>[];
};

/** A declared object page — the XxxView (detail) of a Beas feature. */
export type DetailFeature = {
  header: HeaderConfig;
  sections: Section[];
  /** what a new record starts with in create mode */
  createDefaults?: () => Row;
};

/** One entity's declared pages: its list, its object page, and where its records live. */
export type EntityFeature = {
  entity: string;
  /** side nav / search menu text */
  label: string;
  icon: string;
  /** the single key a row opens by */
  keyField: string;
  list: ListFeature;
  detail: DetailFeature;
};

/** Template hooks (§5). Each gets the form and `content`, the default rendering it replaces. */
export type FormContext = {
  formData: Row;
  isEditMode: boolean;
  isNew: boolean;
  updateField: (key: string, value: unknown) => void;
};
export type SectionTemplate = (ctx: FormContext & { content: ReactNode }) => ReactNode;
export type FieldTemplate = (ctx: FormContext & {
  field: FormField; value: unknown; error?: string; isEditable: boolean;
}) => ReactNode;
