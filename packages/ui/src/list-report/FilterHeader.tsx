import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Bar, Button, CheckBox, DateRangePicker, Dialog, FilterBar, FilterGroupItem, Input, Label, List, ListItemStandard,
  MultiComboBox, MultiComboBoxItem, RadioButton, ResponsivePopover, Text, Title, ToolbarItem, VariantItem,
  VariantManagement, type ButtonDomRef,
} from "@ui5/webcomponents-react";
import { CflField } from "../cfl/CflField.tsx";
import { keysToTokens, tokensToKeys } from "../cfl/cfl-configs.ts";
import { useUiI18n } from "../i18n.ts";
import {
  cleanValues, isEmptyFilter, isMultiField, isRangeField, pickInitial, STANDARD_ID, type View, type ViewsApi,
} from "../views.ts";
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
 *  Manage; Restore for a dirty system view lives on the filter bar. A local list has system
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
  const i18n = useUiI18n();
  const standard = i18n.getText("UI_STANDARD_VIEW");
  const items = useMemo(
    () =>
      views.views.map((v) => (
        <VariantItem key={v.id} data-view-id={v.id} selected={v.id === views.active?.id}
          isDefault={v.isDefault} global={v.visibility === "shared"} author={v.author}
          readOnly={!v.canEdit} labelReadOnly={!v.canEdit}           hideDelete={!v.canEdit}>
          {v.id === STANDARD_ID ? standard : v.name}
        </VariantItem>
      )),
    [views.views, views.active, standard],
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- list and object views alike
type AnyViews = ViewsApi<any>;
type I18n = ReturnType<typeof useUiI18n>;
const viewName = (v: View<unknown>, i18n: I18n) => (v.id === STANDARD_ID ? i18n.getText("UI_STANDARD_VIEW") : v.name);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The Object Page's layout views as a toolbar button, styled like Copy to: the views
 *  in its popover, Save / Save As / Manage under them; Restore for a dirty system view lives on the
 *  filter bar. A local table has system views only and no save chrome; with nothing to choose there
 *  is no button. A Toolbar child: it brings its own ToolbarItem. */
export const ViewMenu = memo(function ViewMenu({ title, views }: { title: string; views: AnyViews }) {
  const i18n = useUiI18n();
  const opener = useRef<ButtonDomRef>(null);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"saveAs" | "manage" | null>(null);
  if (views.local && views.views.length < 2) return null;
  const canSave = views.dirty && !!views.active?.canEdit;
  const close = (next: typeof dialog = null) => { setOpen(false); setDialog(next); };
  return (
    // Keeps an overflowed menu open under the popover, which would otherwise lose its opener.
    <ToolbarItem preventOverflowClosing>
      <Button ref={opener} design="Transparent" endIcon="slim-arrow-down" tooltip={title}
        accessibilityAttributes={{ hasPopup: "dialog", expanded: open }} onClick={() => setOpen(true)}>
        {`${views.active ? viewName(views.active, i18n) : title}${views.dirty ? " *" : ""}`}
      </Button>
      {open ? (
        <ResponsivePopover open opener={opener.current ?? undefined} headerText={title} onClose={() => setOpen(false)}
          footer={views.local ? undefined : (
            <Bar design="Footer" endContent={
              <>
                {canSave ? <Button design="Emphasized" onClick={() => { views.save(); close(); }}>{i18n.getText("UI_SAVE")}</Button> : null}
                <Button design={canSave ? "Transparent" : "Emphasized"} onClick={() => close("saveAs")}>{i18n.getText("UI_SAVE_AS")}</Button>
                <Button design="Transparent" onClick={() => close("manage")}>{i18n.getText("UI_MANAGE")}</Button>
              </>
            } />
          )}>
          <List selectionMode="Single" onItemClick={(e) => {
            const id = (e.detail.item as HTMLElement).dataset.viewId;
            if (id) views.select(id);
            close();
          }}>
            {views.views.map((v) => (
              <ListItemStandard key={v.id} data-view-id={v.id} selected={v.id === views.active?.id}
                description={v.visibility === "shared" ? v.author : undefined}
                additionalText={v.isDefault ? i18n.getText("UI_DEFAULT") : undefined}>
                {viewName(v, i18n)}
              </ListItemStandard>
            ))}
          </List>
        </ResponsivePopover>
      ) : null}
      {/* On the body: a Toolbar may move this item into its overflow, which is hidden once closed. */}
      {dialog === "saveAs" ? createPortal(<SaveViewDialog views={views} onClose={() => setDialog(null)} />, document.body) : null}
      {dialog === "manage" ? createPortal(<ManageViewsDialog views={views} onClose={() => setDialog(null)} />, document.body) : null}
    </ToolbarItem>
  );
});

/** Save As: the current state under a new name. The server refuses a taken name again. */
function SaveViewDialog({ views, onClose }: { views: AnyViews; onClose: () => void }) {
  const i18n = useUiI18n();
  const [name, setName] = useState("");
  const [isDefault, setDefault] = useState(false);
  const [shared, setShared] = useState(false);
  const taken = views.views.some((v) => same(viewName(v, i18n), name));
  const save = () => {
    views.saveAs({ name: name.trim(), visibility: shared && views.isAdmin ? "shared" : "personal", isDefault });
    onClose();
  };
  return (
    <Dialog open headerText={i18n.getText("UI_SAVE_VIEW")} onClose={onClose} footer={
      <Bar design="Footer" endContent={
        <>
          <Button design="Emphasized" disabled={!name.trim() || taken} onClick={save}>{i18n.getText("UI_SAVE")}</Button>
          <Button design="Transparent" onClick={onClose}>{i18n.getText("UI_CANCEL")}</Button>
        </>
      } />
    }>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", minWidth: "20rem" }}>
        <Label for="cf-save-view-name" required showColon>{i18n.getText("UI_NAME")}</Label>
        <Input id="cf-save-view-name" value={name} onInput={(e) => setName(e.target.value)}
          valueState={taken ? "Negative" : "None"}
          valueStateMessage={taken ? <div>{i18n.getText("UI_NAME_TAKEN")}</div> : undefined} />
        <CheckBox text={i18n.getText("UI_SET_DEFAULT")} checked={isDefault} onChange={(e) => setDefault(e.target.checked)} />
        {views.isAdmin ? <CheckBox text={i18n.getText("UI_PUBLIC")} checked={shared} onChange={(e) => setShared(e.target.checked)} /> : null}
      </div>
    </Dialog>
  );
}

/** Manage: rename, share, delete the views this user may edit, and pick the default among all. A
 *  read-only view picked as default only clears the user's own (as UI5's VariantManagement did). */
function ManageViewsDialog({ views, onClose }: { views: AnyViews; onClose: () => void }) {
  const i18n = useUiI18n();
  const [drafts, setDrafts] = useState<Record<string, { name: string; shared: boolean }>>(() => Object.fromEntries(
    views.views.filter((v) => v.canEdit).map((v) => [v.id, { name: v.name, shared: v.visibility === "shared" }]),
  ));
  const [deleted, setDeleted] = useState<string[]>([]);
  const [defaultId, setDefaultId] = useState(() => pickInitial(views.views, null).id);
  const kept = views.views.filter((v) => !deleted.includes(v.id));
  const nameOf = (v: View<unknown>) => drafts[v.id]?.name ?? viewName(v, i18n);
  const bad = (v: View<unknown>) => !nameOf(v).trim() || kept.some((o) => o.id !== v.id && same(nameOf(o), nameOf(v)));
  const save = () => {
    void views.manage({
      deleted,
      updated: kept.flatMap((v) => {
        const d = drafts[v.id];
        if (!d) return [];
        const next = {
          id: v.id, name: d.name.trim(), isDefault: v.id === defaultId,
          visibility: (views.isAdmin ? (d.shared ? "shared" : "personal") : v.visibility) as "personal" | "shared",
        };
        return next.name !== v.name || next.visibility !== v.visibility || next.isDefault !== v.isDefault ? [next] : [];
      }),
    });
    onClose();
  };
  return (
    <Dialog open headerText={i18n.getText("UI_MANAGE_VIEWS")} onClose={onClose} footer={
      <Bar design="Footer" endContent={
        <>
          <Button design="Emphasized" disabled={kept.some(bad)} onClick={save}>{i18n.getText("UI_SAVE")}</Button>
          <Button design="Transparent" onClick={onClose}>{i18n.getText("UI_CANCEL")}</Button>
        </>
      } />
    }>
      <div style={{
        display: "grid", alignItems: "center", gap: "0.25rem 1rem",
        gridTemplateColumns: `minmax(16rem, 1fr) auto${views.isAdmin ? " auto" : ""} 2.25rem`,
      }}>
        <Label>{i18n.getText("UI_NAME")}</Label>
        <Label>{i18n.getText("UI_DEFAULT")}</Label>
        {views.isAdmin ? <Label>{i18n.getText("UI_PUBLIC")}</Label> : null}
        <span />
        {kept.map((v) => {
          const d = drafts[v.id];
          return (
            <Fragment key={v.id}>
              {d ? (
                <Input value={d.name} accessibleName={i18n.getText("UI_NAME")} valueState={bad(v) ? "Negative" : "None"}
                  onInput={(e) => setDrafts((all) => ({ ...all, [v.id]: { ...d, name: e.target.value } }))} />
              ) : <Text>{viewName(v, i18n)}</Text>}
              <RadioButton name="cf-default-view" accessibleName={i18n.getText("UI_DEFAULT")} checked={v.id === defaultId}
                onChange={() => setDefaultId(v.id)} />
              {views.isAdmin ? (
                <CheckBox accessibleName={i18n.getText("UI_PUBLIC")} disabled={!d} checked={d ? d.shared : v.visibility === "shared"}
                  onChange={(e) => setDrafts((all) => ({ ...all, [v.id]: { ...d!, shared: e.target.checked } }))} />
              ) : null}
              {d ? (
                <Button design="Transparent" icon="delete" tooltip={i18n.getText("UI_DELETE")} accessibleName={i18n.getText("UI_DELETE")}
                  onClick={() => setDeleted((all) => [...all, v.id])} />
              ) : <span />}
            </Fragment>
          );
        })}
      </div>
    </Dialog>
  );
}

type FilterState = Pick<ViewState, "adaptFilterKeys" | "filterValues" | "searchTerm">;
export type FilterTemplate = (ctx: { value: FilterValue | undefined; setValue: (v: FilterValue) => void }) => ReactNode;

/** One filter's control by type: value help, options, tri-state boolean, date range, number, text. */
function FilterControl({ field, value, setValue }: {
  field: FilterField; value: FilterValue | undefined; setValue: (v: FilterValue) => void;
}) {
  const i18n = useUiI18n();
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
      <CheckBox checked={on === true} indeterminate={on === undefined}
        text={on === undefined ? i18n.getText("UI_ANY") : on ? i18n.getText("UI_YES") : i18n.getText("UI_NO")}
        onChange={() => setValue(on === undefined ? true : on ? false : null)} />
    );
  }
  if (isRangeField(field)) {
    const r = value && typeof value === "object" && !Array.isArray(value) ? value : { from: "", to: "" };
    // The picker's :host is min-width 15rem, the FilterBar's cells 13.125rem (flex-grown): whenever a
    // row has little width to spare it ran under the next filter. FilterBar's docs say to drop it.
    return (
      <DateRangePicker style={{ minWidth: "auto" }} valueFormat="yyyy-MM-dd" delimiter="~" accessibleName={field.label}
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
  const i18n = useUiI18n();
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
        <Input placeholder={searchPlaceholder ?? i18n.getText("UI_SEARCH")} value={draft.search} showClearIcon
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
