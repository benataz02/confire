import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bar, Button, Dialog, FlexBox, Menu, MenuItem, ObjectPage as Ui5ObjectPage, SplitButton, Tab, TabContainer,
  ToolbarButton, ToolbarItem, type ObjectPageDomRef,
} from "@ui5/webcomponents-react";
import { useUiI18n } from "../i18n.ts";
import { ColumnsTab, type ColumnItem } from "../list-report/GridSettingsDialog.tsx";
import { ViewMenu } from "../list-report/FilterHeader.tsx";
import { sectionFields, sectionTables } from "../metadata.ts";
import { negativeCount, PageMessages, type PageMessage } from "../PageMessages.tsx";
import { evalDyn } from "../validation.ts";
import { useViews } from "../views.ts";
import { applyObjectView, resolveObjectState, withTableColumns } from "./objectView.ts";
import { objectPageHeaderArea, objectPageTitle, recordTitle, type RecordNavigation } from "./ObjectPageHeader.tsx";
import type { Crumb } from "../PageBreadcrumbs.tsx";
import { objectPageSection, type SectionContext, type Templates } from "./ObjectPageSection.tsx";
import { useSectionParam } from "./sectionParam.ts";
import { useObjectRecord, type CreateAction, type ObjectRecord, type RecordOptions } from "./useObjectRecord.ts";
import type { FormField, HeaderConfig, ObjectViewState, Section } from "../types.ts";

// app-object-page (LIST-REPORT-OBJECT-PAGE.md §4): a declared section tree over one record, merged
// with the entity's metadata when there is one. The record's lifecycle is useObjectRecord's; this
// draws it — title, sections (one scrolling page, or tabs), the footer, and every problem the record
// has as one messages button in the title.

export type { CreateAction } from "./useObjectRecord.ts";

/** Object views are stored under `<entity>::object` (OBJECT_TABLE_SUFFIX on the server). */
const objectTableId = (entity: string) => `${entity}::object`;

type PageProps = Templates & {
  /** names the layout views and the remembered create action */
  entity: string;
  header: HeaderConfig;
  /** one section at a time behind a tab bar, the open one in the URL (`?section=`) */
  mode?: "tabs";
  /** Edit is offered but disabled — no ETag came with the row */
  editDisabled?: boolean;
  /** layout views without server calls or save chrome */
  localViews?: boolean;
  /** one create button with this text, instead of the create-and-view/new/back split button */
  createLabel?: string;
  navigation?: RecordNavigation;
  /** the parent pages, above the title */
  breadcrumbs?: Crumb[];
  /** an informational strip above the first section — information, never a problem */
  notice?: ReactNode;
  /** the caller's own messages beside the record's: a failed read, a refused Delete */
  messages?: PageMessage[];
};

/** A record made outside (kept alive across routes), or the options the page makes one from. */
export type ObjectPageProps = PageProps & ({ record: ObjectRecord } | RecordOptions);

export function ObjectPage(p: ObjectPageProps) {
  return "record" in p ? <Page {...p} record={p.record} /> : <OwnRecord {...p} />;
}

function OwnRecord(p: PageProps & RecordOptions) {
  const record = useObjectRecord(p);
  return <Page {...p} record={record} />;
}

function Page({ record: r, ...p }: PageProps & { record: ObjectRecord }) {
  const i18n = useUiI18n();
  const t = (key: string, ...params: Array<string | number>) => i18n.getText(key, ...params);
  const createText = (a: CreateAction) =>
    a === "new" ? t("UI_CREATE_AND_NEW") : a === "back" ? t("UI_CREATE_AND_BACK") : t("UI_CREATE_AND_VIEW");
  const fields = r.constraints?.fields;
  const label = r.constraints?.label ?? "";
  const tabs = p.mode === "tabs";
  const section = useSectionParam();
  const pageRef = useRef<ObjectPageDomRef>(null);
  // A message's jump: the tab in tabs mode (a URL, so Back leaves the record), else the section
  // scrolled in. Focus first: focus entering the content sets the page's scroll padding (the sticky
  // title and anchor bar), so the section lands below them rather than under.
  const goSection = (id: string) => {
    if (tabs) return section.go(id);
    const el = pageRef.current?.querySelector<HTMLElement>(`[id="ObjectPageSection-${id}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "start" });
  };

  // --- layout views ---------------------------------------------------------------------------
  const resolveLayout = useCallback((s: Partial<ObjectViewState> | null) => resolveObjectState(s, r.sections), [r.sections]);
  const layout = useViews<ObjectViewState>({ tableId: objectTableId(p.entity), resolve: resolveLayout, local: p.localViews });
  const [layoutOpen, setLayoutOpen] = useState(false);
  // Whatever the layout says, edit mode shows what it can write and what it must send.
  const mustShow = useCallback(
    (f: FormField) => r.isEditMode && (r.isEditable(f) || !!evalDyn(f.required, r.formData, r.isEditMode, r.isNew)),
    [r.isEditMode, r.isEditable, r.formData, r.isNew],
  );
  const shown = useMemo(() => {
    const ids = new Set(r.visible.map((s) => s.id));
    return (layout.state ? applyObjectView(r.sections, layout.state, mustShow) : r.sections).filter((s) => ids.has(s.id));
  }, [r.sections, r.visible, layout.state, mustShow]);

  // --- messages -------------------------------------------------------------------------------
  // Every problem the record has, under the section it belongs to, plus the caller's own.
  const headerCtx = { formData: r.formData, isEditMode: r.isEditMode, isNew: r.isNew, constraints: r.constraints };
  const title = recordTitle(p.header, headerCtx, label, t);
  const messages = useMemo<PageMessage[]>(() => {
    const where = new Map<string, { section: Section; label: string }>();
    for (const s of r.sections) {
      for (const f of sectionFields(s)) where.set(f.key, { section: s, label: f.label ?? f.key });
      for (const tb of sectionTables(s)) where.set(tb.key, { section: s, label: s.subsections?.find((x) => x.table === tb)?.label ?? s.label });
    }
    const out: PageMessage[] = [];
    for (const [key, text] of Object.entries(r.errors)) {
      const w = where.get(key);
      out.push({ id: `field:${key}`, type: "Negative", text, detail: w?.label, group: w?.section.label ?? title, section: w?.section.id, anchor: `[data-field="${key}"]` });
    }
    for (const [key, cells] of Object.entries(r.cellErrors)) {
      const w = where.get(key);
      const cols = (w ? sectionTables(w.section).find((x) => x.key === key)?.columns : undefined) ?? [];
      for (const [cell, text] of Object.entries(cells)) {
        const [row = "0", col = ""] = cell.split(":");
        out.push({
          id: `cell:${key}:${cell}`, type: "Negative", text,
          detail: t("UI_CELL", w?.label ?? key, Number(row) + 1, cols.find((c) => c.key === col)?.label ?? col),
          group: w?.section.label ?? title, section: w?.section.id, anchor: `[data-field="${key}"]`,
        });
      }
    }
    for (const m of r.other) {
      const s = r.sections.find((x) => x.id === m.section);
      out.push({ ...m, id: `other:${m.id}`, type: "Negative", group: s?.label ?? title });
    }
    if (r.saveError) out.push({ id: "save", type: "Negative", text: r.saveError, detail: t("UI_SAVE_FAILED"), group: title });
    return [...out, ...(p.messages ?? [])];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.sections, r.errors, r.cellErrors, r.other, r.saveError, p.messages, title, i18n]);

  // --- create action --------------------------------------------------------------------------
  const storageKey = `confire.createAction.${p.entity}`;
  const [createAction, setCreateAction] = useState<CreateAction>(
    () => (localStorage.getItem(storageKey) as CreateAction | null) ?? "view",
  );
  const [createMenu, setCreateMenu] = useState(false);
  const menuId = `confire-create-${p.entity}`;
  const creating = r.isNew && !r.alwaysEdit;

  // --- render ---------------------------------------------------------------------------------
  const ctx: SectionContext = {
    formData: r.formData, isEditMode: r.isEditMode, isNew: r.isNew, updateField: r.updateField, update: r.update,
    errors: r.errors,
    cellErrors: r.cellErrors,
    isEditable: r.isEditable,
    isTableEditable: r.isTableEditable,
    onExistenceError: r.onExistenceError,
    onCheckStarted: r.onCheckStarted,
    onRowSelect: r.onRowSelect,
    onTableColumns: layout.state ? (id, keys) => layout.setState((s) => withTableColumns(s, id, keys)) : undefined,
    templates: p,
    titleOf: (s) => {
      const n = negativeCount(messages, s.id);
      return n ? t("UI_SECTION_COUNT", s.label, n) : s.label;
    },
  };

  const banner = p.notice ? (
    <FlexBox direction="Column" style={{ gap: "0.5rem", marginBottom: "0.5rem" }}>{p.notice}</FlexBox>
  ) : null;

  const layoutControl = p.localViews ? undefined : (
    <>
      <ViewMenu title={t("UI_LAYOUT")} views={layout} />
      <ToolbarButton design="Transparent" icon="action-settings" tooltip={t("UI_ADAPT_LAYOUT")} accessibleName={t("UI_ADAPT_LAYOUT")}
        disabled={!layout.state} onClick={() => setLayoutOpen(true)} />
    </>
  );

  return (
    <>
      <Ui5ObjectPage
        ref={pageRef}
        hidePinButton
        mode={tabs ? "IconTabBar" : "Default"}
        {...(tabs ? section.props : {})}
        titleArea={objectPageTitle({
          header: p.header, formData: r.formData, label, ctx: headerCtx,
          onEdit: !r.readonly && r.constraints?.writable && !r.isEditMode ? r.startEdit : undefined,
          t,
          editDisabled: p.editDisabled,
          navigation: p.navigation,
          breadcrumbs: p.breadcrumbs,
          messages: (
            <ToolbarItem overflowPriority="NeverOverflow">
              <PageMessages messages={messages} onSection={goSection} openOn={r.refused} />
            </ToolbarItem>
          ),
          layout: layoutControl,
        })}
        headerArea={objectPageHeaderArea(p.header.facets, r.formData, fields)}
        footerArea={r.isEditMode ? (
          <Bar design="FloatingFooter" endContent={
            <>
              {!creating ? (
                // A new record is unsaved by definition: pressing Save is what shows what it still needs.
                <Button design="Emphasized" disabled={r.saving || (!r.dirty && !r.isNew)} onClick={() => void r.save()}>
                  {r.saving ? t("UI_SAVING") : t("UI_SAVE")}
                </Button>
              ) : p.createLabel ? (
                <Button design="Emphasized" disabled={r.saving} onClick={() => void r.save()}>
                  {r.saving ? t("UI_CREATING") : p.createLabel}
                </Button>
              ) : (
                <SplitButton id={menuId} design="Emphasized" disabled={r.saving}
                  accessibilityAttributes={{ arrowButton: { hasPopup: "menu", expanded: createMenu } }}
                  onClick={() => void r.save(undefined, createAction)} onArrowClick={() => setCreateMenu(true)}>
                  {r.saving ? t("UI_CREATING") : createText(createAction)}
                </SplitButton>
              )}
              <Button disabled={r.saving} onClick={() => void r.cancel()}>{t("UI_CANCEL")}</Button>
            </>
          } />
        ) : undefined}
      >
        {shown.map((s, i) => objectPageSection(s, { ...ctx, banner: i === 0 ? banner : undefined }))}
      </Ui5ObjectPage>
      {createMenu ? (
        <Menu open opener={menuId} onClose={() => setCreateMenu(false)}
          onItemClick={(e) => {
            const a = (e.detail.item as HTMLElement).dataset.action as CreateAction;
            setCreateMenu(false);
            setCreateAction(a);
            localStorage.setItem(storageKey, a);
            void r.save(undefined, a);
          }}>
          {(["view", "new", "back"] as CreateAction[]).map((a) => (
            <MenuItem key={a} data-action={a} text={createText(a)} icon={a === createAction ? "accept" : undefined} />
          ))}
        </Menu>
      ) : null}
      {layoutOpen && layout.state ? (
        <LayoutDialog sections={r.sections} state={layout.state} mustShow={mustShow}
          onClose={() => setLayoutOpen(false)}
          onConfirm={(next) => { layout.setState(next); setLayoutOpen(false); }} />
      ) : null}
    </>
  );
}

/** "Adapt layout": the GridSettingsDialog Columns tab, once for the sections and once per section
 *  for its fields (or its table's columns). */
function LayoutDialog({ sections, state, mustShow, onConfirm, onClose }: {
  sections: Section[];
  state: ObjectViewState;
  mustShow: (f: FormField) => boolean;
  onConfirm: (next: ObjectViewState) => void;
  onClose: () => void;
}) {
  const i18n = useUiI18n();
  const [draft, setDraft] = useState(state);
  const byId = new Map(sections.map((s) => [s.id, s]));
  const labelOf = (s: Section, key: string) =>
    (s.table?.columns.find((c) => c.key === key)?.label ?? sectionFields(s).find((f) => f.key === key)?.label) ?? key;
  const fieldOf = (s: Section, key: string) => sectionFields(s).find((f) => f.key === key);

  const sectionItems: ColumnItem[] = draft.sections.map((v) => {
    const s = byId.get(v.id);
    return { key: v.id, label: s?.label ?? v.id, visible: v.visible };
  });

  return (
    <Dialog open onClose={onClose} headerText={i18n.getText("UI_ADAPT_LAYOUT")} resizable className="confire-flush"
      style={{ width: "min(56rem, 95vw)", height: "min(40rem, 85vh)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" onClick={() => onConfirm(draft)}>{i18n.getText("UI_OK")}</Button>
            <Button design="Transparent" onClick={onClose}>{i18n.getText("UI_CANCEL")}</Button>
          </>
        } />
      }>
      <TabContainer className="confire-flush" style={{ height: "100%" }}>
        <Tab text={i18n.getText("UI_SECTIONS")} selected>
          <ColumnsTab items={sectionItems}
            onChange={(items) => setDraft((d) => ({
              sections: items.map((it) => ({ ...d.sections.find((x) => x.id === it.key)!, visible: it.visible })),
            }))} />
        </Tab>
        {draft.sections.map((v) => {
          const s = byId.get(v.id);
          if (!s) return null;
          const items: ColumnItem[] = v.fields.map((f) => {
            const field = fieldOf(s, f.key);
            return { key: f.key, label: labelOf(s, f.key), visible: f.visible, locked: field ? mustShow(field) : false };
          });
          return (
            <Tab key={v.id} text={s.label}>
              <ColumnsTab items={items}
                onChange={(next) => setDraft((d) => ({
                  sections: d.sections.map((x) => (x.id !== v.id ? x : {
                    ...x,
                    fields: next.map((it) => ({ key: it.key, visible: it.visible })),
                  })),
                }))} />
            </Tab>
          );
        })}
      </TabContainer>
    </Dialog>
  );
}
