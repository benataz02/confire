import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CheckBox, DateRangePicker, FilterBar, FilterGroupItem, Input, MultiComboBox, MultiComboBoxItem, Title,
  VariantItem, VariantManagement,
} from "@ui5/webcomponents-react";
import { CflField } from "../cfl/CflField.tsx";
import { keysToTokens, tokensToKeys } from "../cfl/cfl-configs.ts";
import { cleanValues, isEmptyFilter, isMultiField, isRangeField, type ViewsApi } from "../views.ts";
import type { FilterField, FilterValue, Row, ViewState } from "../types.ts";

// beas-header (LIST-REPORT-OBJECT-PAGE.md §3.3), split in two because DynamicPage takes the title
// and the filter bar in different slots: ViewTitle is the view selector in the title,
// FilterHeader is the FilterBar with Go / Clear / Adapt Filters and the search box.
//
// Nothing in UI5's React layer is memo()'d, so each half sits behind memo() and owns its own
// state: a filter keystroke goes no further than the header, and nothing above re-renders until Go.

// VariantManagement's dialog flags come back as boolean | "true" | "false". Coerce.
const truthy = (v: unknown): boolean => v === true || v === "true";
const viewIdOf = (v: unknown): string | undefined =>
  (v as { "data-view-id"?: string; variantItem?: HTMLElement } | undefined)?.["data-view-id"] ??
  (v as { variantItem?: HTMLElement } | undefined)?.variantItem?.dataset.viewId;

/** The view selector as the page title (Beas `beas-view-filters type="title"`): Save, Save As,
 *  Manage; Restore for a dirty system view lives on the filter bar. A portal list has system
 *  views only and no save chrome; a table with nothing to choose is a plain title. */
export const ViewTitle = memo(function ViewTitle({ slot, title, views, size }: {
  /** filled in by DynamicPageTitle's slot handling — forward it or the element is never slotted */
  slot?: string;
  title: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- list and object views alike
  views: ViewsApi<any>;
  /** the object page's layout selector is a small one */
  size?: "H4" | "H5" | "H6";
}) {
  const items = useMemo(
    () =>
      views.views.map((v) => (
        <VariantItem key={v.id} data-view-id={v.id} selected={v.id === views.active?.id}
          isDefault={v.isDefault} global={v.visibility === "shared"} author={v.author}
          readOnly={!v.canEdit} labelReadOnly={!v.canEdit} hideDelete={!v.canEdit}>
          {v.name}
        </VariantItem>
      )),
    [views.views, views.active],
  );
  if (views.local && views.views.length < 2) return <Title slot={slot} level="H4">{title}</Title>;
  return (
    <VariantManagement
      slot={slot}
      size={size}
      closeOnItemSelect
      dirtyState={views.dirty}
      hideShare={!views.isAdmin}
      hideApplyAutomatically
      hideSaveAs={views.local}
      hideManageVariants={views.local}
      titleText={title}
      onSelect={(e) => {
        const id = viewIdOf(e.detail.selectedVariant);
        if (id) views.select(id);
      }}
      onSave={() => views.save()}
      onSaveAs={(e) => views.saveAs({
        name: String(e.detail.children),
        visibility: truthy(e.detail.global) && views.isAdmin ? "shared" : "personal",
        isDefault: truthy(e.detail.isDefault),
      })}
      onSaveManageViews={(e) => {
        const editable = new Set(views.views.filter((v) => v.canEdit).map((v) => v.id));
        void views.manage({
          deleted: e.detail.deletedVariants.map(viewIdOf).filter((id): id is string => !!id && editable.has(id)),
          updated: e.detail.updatedVariants.flatMap((u) => {
            const id = viewIdOf(u) ?? viewIdOf(u.prevVariant);
            return id && editable.has(id)
              ? [{ id, name: String(u.children), visibility: truthy(u.global) && views.isAdmin ? "shared" as const : "personal" as const, isDefault: truthy(u.isDefault) }]
              : [];
          }),
        });
      }}
    >
      {items}
    </VariantManagement>
  );
});

type FilterState = Pick<ViewState, "adaptFilterKeys" | "filterValues" | "searchTerm">;
export type FilterTemplate = (ctx: { value: FilterValue | undefined; setValue: (v: FilterValue) => void }) => ReactNode;

/** One filter's control by type: value help, options, tri-state boolean, date range, number, text. */
function FilterControl({ field, value, setValue }: {
  field: FilterField; value: FilterValue | undefined; setValue: (v: FilterValue) => void;
}) {
  if (field.cfl) {
    // Filters never say "not found", and are multi-select unless the dialog says otherwise (`g()`).
    const multi = isMultiField(field);
    const config = { ...field.cfl, mustExist: false, dialogConfig: { ...field.cfl.dialogConfig, multiSelect: multi } };
    return (
      <CflField config={config} mustExist={false} accessibleName={field.label}
        value={multi ? keysToTokens(value, config.dialogConfig) : value}
        onValueChange={(v) => setValue(multi ? tokensToKeys((v as Row[]) ?? [], config.dialogConfig) : ((v ?? "") as FilterValue))} />
    );
  }
  if (field.options) {
    const selected = (Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value]).map(String);
    return (
      <MultiComboBox filter="Contains" accessibleName={field.label}
        onSelectionChange={(e) => setValue(e.detail.items.flatMap((i) => {
          const o = field.options!.find((x) => String(x.value) === (i as HTMLElement).dataset.v);
          return o ? [o.value as string | number] : [];
        }))}>
        {field.options.map((o) => (
          <MultiComboBoxItem key={String(o.value)} data-v={String(o.value)} text={o.label} selected={selected.includes(String(o.value))} />
        ))}
      </MultiComboBox>
    );
  }
  if (field.type === "boolean") {
    // A filter has a third state a checkbox field does not: unfiltered. Any -> Yes -> No -> Any.
    const on = value === true || value === "true" ? true : value === false || value === "false" ? false : undefined;
    return (
      <CheckBox checked={on === true} indeterminate={on === undefined} text={on === undefined ? "Any" : on ? "Yes" : "No"}
        onChange={() => setValue(on === undefined ? true : on ? false : null)} />
    );
  }
  if (isRangeField(field)) {
    const r = value && typeof value === "object" && !Array.isArray(value) ? value : { from: "", to: "" };
    return (
      <DateRangePicker valueFormat="yyyy-MM-dd" delimiter="~" accessibleName={field.label}
        value={r.from || r.to ? `${r.from} ~ ${r.to || r.from}` : ""}
        onChange={(e) => {
          const [from = "", to = ""] = (e.detail.value ?? "").split("~").map((s) => s.trim());
          setValue({ from, to: to || from });
        }} />
    );
  }
  return (
    <Input type={field.type === "number" ? "Number" : "Text"} accessibleName={field.label}
      value={value === null || value === undefined ? "" : String(value)}
      onInput={(e) => {
        const v = e.target.value ?? "";
        setValue(field.type === "number" && v !== "" ? Number(v) : v);
      }} />
  );
}

/** The filter bar. Owns the draft: values live here until Go, Clear or Adapt Filters apply them. */
export const FilterHeader = memo(function FilterHeader({
  slot, pool, state, onApply, onRestore, showSearch = true, showAdaptFilters = true, filterTemplates, searchPlaceholder,
}: {
  slot?: string;
  pool: FilterField[];
  /** the applied filters */
  state: FilterState;
  onApply: (next: FilterState) => void;
  /** a dirty system view: offer Restore */
  onRestore?: () => void;
  showSearch?: boolean;
  showAdaptFilters?: boolean;
  filterTemplates?: Record<string, FilterTemplate>;
  searchPlaceholder?: string;
}) {
  const [draft, setDraft] = useState({ values: state.filterValues, search: state.searchTerm });
  // A view switch, a restore or a URL rewrite replaces the applied filters; copy them into the bar.
  useEffect(() => setDraft({ values: state.filterValues, search: state.searchTerm }), [state.filterValues, state.searchTerm]);

  const setValue = (key: string, v: FilterValue) =>
    setDraft((d) => {
      const values: Record<string, FilterValue> = { ...d.values, [key]: v };
      // dependsOn: a filter that only means something under another one resets when that changes.
      for (const f of pool) if (f.dependsOn?.includes(key)) delete values[f.key];
      return { ...d, values };
    });

  const apply = (over: Partial<FilterState> = {}) =>
    onApply({ adaptFilterKeys: state.adaptFilterKeys, filterValues: cleanValues(draft.values), searchTerm: draft.search.trim(), ...over });

  // The view's order first, then everything else Adapt Filters can offer. An active filter is
  // always shown, so its value cannot hide off-screen.
  const ordered = useMemo(() => {
    const rank = new Map(state.adaptFilterKeys.map((k, i) => [k, i]));
    return [...pool].sort((a, b) => (rank.get(a.key) ?? 1e6) - (rank.get(b.key) ?? 1e6));
  }, [pool, state.adaptFilterKeys]);

  return (
    <FilterBar
      slot={slot}
      hideToolbar
      enableReordering
      showGoOnFB
      showClearOnFB
      showRestoreOnFB={!!onRestore}
      hideFilterConfiguration={!showAdaptFilters}
      onGo={() => apply()}
      onClear={() => {
        const defaults = Object.fromEntries(pool.filter((f) => f.defaultValue !== undefined).map((f) => [f.key, f.defaultValue!]));
        setDraft({ values: defaults, search: "" });
        onApply({ adaptFilterKeys: state.adaptFilterKeys, filterValues: cleanValues(defaults), searchTerm: "" });
      }}
      onRestore={() => onRestore?.()}
      onFiltersDialogSave={(e) => {
        const selected = new Set(e.detail.selectedFilterKeys.map(String));
        const order = (e.detail.reorderedFilterKeys ?? ordered.map((f) => f.key)).map(String);
        apply({ adaptFilterKeys: order.filter((k) => selected.has(k)) });
      }}
      search={showSearch ? (
        <Input placeholder={searchPlaceholder ?? "Search"} value={draft.search} showClearIcon
          onInput={(e) => setDraft((d) => ({ ...d, search: e.target.value ?? "" }))}
          onKeyDown={(e) => { if (e.key === "Enter") apply({ searchTerm: (e.target as HTMLInputElement).value?.trim() ?? draft.search }); }} />
      ) : undefined}
    >
      {ordered.map((f) => {
        const value = draft.values[f.key];
        const active = !isEmptyFilter(value);
        const inBar = state.adaptFilterKeys.includes(f.key) || !isEmptyFilter(state.filterValues[f.key]);
        const tpl = filterTemplates?.[f.key];
        return (
          <FilterGroupItem key={f.key} filterKey={f.key} label={f.label ?? f.key} active={active} hiddenInFilterBar={!inBar}>
            {tpl
              ? <>{tpl({ value, setValue: (v) => setValue(f.key, v) })}</>
              : <FilterControl field={f} value={value} setValue={(v) => setValue(f.key, v)} />}
          </FilterGroupItem>
        );
      })}
    </FilterBar>
  );
});
