import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Bar, Button, BusyIndicator, IllustratedMessage, Input, ObjectPage,
  SplitterElement, SplitterLayout, Table, TableCell, TableHeaderCell,
  TableHeaderRow, TableRow, TableRowAction, Text, Title,
  type TableHeaderRowDomRef,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/AddColumn.js";
import { formState, isTableGroup, itemsTable, propagate, type Entries, type ResolvedLookups, type TableRows } from "@confire/config-engine";
import type { Issue, ModelDef, Param, TableDef } from "@confire/config-engine";
import { confirm } from "@confire/ui/confirm.ts";
import { ExprInput } from "./ExprInput.tsx";
import type { ParamSearch } from "./paramRoute.ts";
import { TableDialog, newCalcTable } from "./TableDialog.tsx";
import { localizeItems } from "./starterModel.ts";
import { TitleDialog } from "./TitleDialog.tsx";
import type { TableCols } from "./exprHelpers.ts";
import { configuratorSections } from "@confire/ui/configurator/ConfiguratorForm.tsx";
import { setEntry } from "@confire/ui/configurator/formHelpers.ts";
import { issueFor } from "./useDraftModel.ts";
import { applyMove, canDrop, deleteNode, duplicateParam, parseRowKey, placeTable, rowKeyOf, tableKeyAt, type Placement, type RowRef } from "./structureOps.ts";
import { useI18n } from "../../i18n.ts";
import { copy, type Translate } from "./builderMessages.ts";

type Tables = TableCols[];
type Update = (fn: (d: ModelDef) => ModelDef) => void;

function paramDetail(p: Param, t: Translate): string {
  const bits: string[] = [p.type, p.ui];
  if (p.domain) bits.push(p.domain.kind === "range" ? t("MODEL_KIND_RANGE")
    : p.domain.ref.source === "manual" ? t("MODEL_SRC_MANUAL")
    : p.domain.ref.source === "query" ? t("MODEL_SRC_QUERY")
    : t("MODEL_BADGE_TABLE"));
  if (p.excludeFromDomains) bits.push(t("MODEL_EXCLUDED"));
  return bits.join(" · ");
}

// UI5 cozy icon-button min width — reserved so leaf labels indent past group labels.
const TOGGLE = "2.25rem";

function Gutter({ depth, children, collapse, style }: {
  depth: number;
  children: ReactNode;
  collapse?: { collapsed: boolean; onToggle: () => void };
  style?: CSSProperties;
}) {
  const i18n = useI18n();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.25rem", paddingInlineStart: `${depth * 1.5}rem`, ...style }}>
      {collapse ? (
        // Chevron is a real button, indented with the level; stopPropagation so a toggle never enters edit (onRowClick).
        <Button design="Transparent" style={{ flex: "0 0 auto" }}
          icon={collapse.collapsed ? "slim-arrow-right" : "slim-arrow-down"}
          tooltip={collapse.collapsed ? i18n.getText("MODEL_EXPAND") : i18n.getText("MODEL_COLLAPSE")}
          accessibilityAttributes={{ expanded: collapse.collapsed ? "false" : "true" }}
          onClick={(e) => { e.stopPropagation(); collapse.onToggle(); }} />
      ) : (
        <span style={{ flex: `0 0 ${TOGGLE}`, inlineSize: TOGGLE }} aria-hidden />
      )}
      {children}
    </div>
  );
}

// Param-row actions only: section/group/formula stay visible. Touch keeps param actions
// visible — no hover, and opacity:0 would make delete/dup untappable.
//
// Section and group backgrounds have to come from here too: TableRow has no highlight/background
// prop, and a document-level rule is the one thing that beats the shadow root's own `:host`.
if (typeof document !== "undefined" && !document.getElementById("confire-params-rows")) {
  const el = document.createElement("style");
  el.id = "confire-params-rows";
  const R = `.confire-params-struct [ui5-table-row]`;
  el.textContent =
    `@media (hover: hover){${R}[row-key^="p:"] [ui5-table-row-action]{opacity:0;pointer-events:none}` +
    `${R}[row-key^="p:"]:hover [ui5-table-row-action],${R}[row-key^="p:"]:focus-within [ui5-table-row-action]{opacity:1;pointer-events:auto}}` +
    `${R}[row-key^="s:"]{background:var(--sapList_TableGroupHeaderBackground);` +
    `border-block-end:1px solid var(--sapList_TableGroupHeaderBorderColor)}` +
    `${R}[row-key^="g:"]{background:var(--sapList_Hover_Background)}`;
  document.head.appendChild(el);
}

// UI5 clips the actions-column header (a11y-only "Row Actions") inside the header-row shadow.
function revealActionsHeader(el: TableHeaderRowDomRef | null, label: string) {
  const sr = el?.shadowRoot;
  if (!sr) return;
  const css = `#actions-cell-content{position:static;clip:auto;font-size:0}#actions-cell-content::after{content:"${label}";font-size:var(--sapFontSize);font-family:var(--sapFontSemiboldDuplexFamily);color:var(--sapList_HeaderTextColor)}`;
  const existing = sr.getElementById("confire-actions-hdr");
  if (existing) { existing.textContent = css; return; }
  const style = document.createElement("style");
  style.id = "confire-actions-hdr";
  style.textContent = css;
  sr.appendChild(style);
}

/** Where the live preview sits relative to the structure tree; picked in the page's title bar. */
export type PreviewAt = "left" | "top" | "bottom" | "right" | "hidden";

export function ParamsTab({ modelId, draft, update, issues, tables, lookups, lookupsFailed, onRetryLookups, previewAt }: {
  /** absent while the model itself is still unsaved — the parameter page lives under `/models/new` */
  modelId?: string;
  draft: ModelDef; update: Update; issues: Issue[]; tables: Tables;
  lookups?: ResolvedLookups; lookupsFailed?: boolean; onRetryLookups: () => void; previewAt: PreviewAt;
}) {
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);
  const navigate = useNavigate({ from: "/$slug" });
  const openParam = (search: ParamSearch) => {
    if (modelId) void navigate({ to: "/$slug/models/$id/parameter", params: { id: modelId }, search });
    else void navigate({ to: "/$slug/models/new/parameter", search });
  };
  const onHeader = useCallback((el: TableHeaderRowDomRef | null) => {
    revealActionsHeader(el, t("MODEL_ACTIONS"));
  }, [i18n]);
  // Table being edited in the dialog, by key — the dialog buffers its own copy.
  const [tableEdit, setTableEdit] = useState<string | null>(null);
  // Formula row switched to its live editors; every other row shows read-only text, which is the
  // whole reason the rows are the same height.
  const [fEdit, setFEdit] = useState<number | null>(null);
  // Section/group whose heading is open in TitleDialog, with the values it opens on.
  const [titleEdit, setTitleEdit] = useState<{ ref: RowRef; initial: string } | null>(null);
  // Keyed by stable section/group/param key (not row index) so collapse survives drag-reordering.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((c) => { const n = new Set(c); n.delete(id) || n.add(id); return n; });

  type StructRow = { kind: "struct"; key: string; depth: number; label: string; detail: string; ref: RowRef; collapseId?: string };
  type Row = StructRow | { kind: "formula"; key: string; idx: number };
  const rows: Row[] = [];
  const defOf = (k: string): TableDef | undefined => (draft.tables ?? []).find((t) => t.key === k);

  // A formula is global and the model stores nothing positional about one, so they all draw under
  // the last placed parameter — the one row guaranteed to be there to hang them on.
  const lastParam = draft.structure.sections
    .flatMap((s) => s.groups.flatMap((g) => (isTableGroup(g) ? [] : g.params))).at(-1);
  const formulas = draft.computed.map((_, i) => i);

  draft.structure.sections.forEach((s, si) => {
    const sId = `S:${s.key}`;
    rows.push({ kind: "struct", key: rowKeyOf({ kind: "section", s: si }), depth: 0, label: s.title, detail: t("MODEL_DETAIL_SECTION", s.key), ref: { kind: "section", s: si }, collapseId: sId });
    if (collapsed.has(sId)) return;
    s.groups.forEach((g, gi) => {
      // A table is a group, so it draws at group depth with no children and no collapse chevron.
      if (isTableGroup(g)) {
        const def = defOf(g.table);
        const cols = def
          ? t(def.columns.length === 1 ? "MODEL_COLUMNS_ONE" : "MODEL_COLUMNS_MANY", String(def.columns.length))
          : "";
        rows.push({
          kind: "struct", key: rowKeyOf({ kind: "table", s: si, g: gi }), depth: 1, label: def?.title || g.table,
          detail: def
            ? t("MODEL_DETAIL_TABLE", def.role === "items" ? t("MODEL_ITEM_GRID") : t("MODEL_CALC_TABLE"), cols)
            : t("MODEL_MISSING_TABLE"),
          ref: { kind: "table", s: si, g: gi },
        });
        return;
      }
      const gId = `G:${s.key}/${g.key}`;
      rows.push({ kind: "struct", key: rowKeyOf({ kind: "group", s: si, g: gi }), depth: 1, label: g.title, detail: t("MODEL_DETAIL_GROUP", g.key), ref: { kind: "group", s: si, g: gi }, collapseId: gId });
      if (collapsed.has(gId)) return;
      g.params.forEach((k) => {
        const p = draft.parameters.find((x) => x.key === k);
        const own = k === lastParam ? formulas : [];
        const pId = `P:${k}`;
        rows.push({
          kind: "struct", key: rowKeyOf({ kind: "param", key: k }), depth: 2, label: p?.label || k,
          detail: p ? paramDetail(p, t) : t("MODEL_MISSING_PARAM"),
          ref: { kind: "param", key: k },
          // Only a parameter that anchors formulas has anything to collapse.
          collapseId: own.length ? pId : undefined,
        });
        if (collapsed.has(pId)) return;
        for (const i of own) rows.push({ kind: "formula", key: `c:${i}`, idx: i });
      });
    });
  });
  // Only reachable with no parameter placed anywhere — there is no row to hang them under.
  if (!lastParam) for (const i of formulas) rows.push({ kind: "formula", key: `c:${i}`, idx: i });

  // Confirm only when a delete is destructive: a section/group with children (cascades), or a
  // parameter (drops its whole definition). Empty sections/groups delete without a prompt.
  const confirmDelete = async (ref: RowRef) => {
    let message: string | null = null;
    if (ref.kind === "section") {
      const sec = draft.structure.sections[ref.s];
      const groups = sec?.groups.length ?? 0;
      const params = sec?.groups.reduce((n, g) => n + (isTableGroup(g) ? 0 : g.params.length), 0) ?? 0;
      if (groups > 0) {
        const groupsPhrase = t(groups === 1 ? "MODEL_GROUPS_ONE" : "MODEL_GROUPS_MANY", String(groups));
        const andParams = params
          ? ` ${t("MODEL_AND", t(params === 1 ? "MODEL_PLACED_ONE" : "MODEL_PLACED_MANY", String(params)))}`
          : "";
        message = t(groups === 1 ? "MODEL_DELETE_SECTION_ONE" : "MODEL_DELETE_SECTION_MANY", sec?.title ?? "", groupsPhrase + andParams);
      }
    } else if (ref.kind === "group") {
      const grp = draft.structure.sections[ref.s]?.groups[ref.g];
      const params = grp && !isTableGroup(grp) ? grp.params.length : 0;
      if (params) message = t(params === 1 ? "MODEL_DELETE_GROUP_ONE" : "MODEL_DELETE_GROUP_MANY", grp && !isTableGroup(grp) ? grp.title : "", String(params));
    } else if (ref.kind === "table") {
      const key = tableKeyAt(draft, ref.s, ref.g) ?? "";
      const def = defOf(key);
      message = t("MODEL_DELETE_TABLE_MSG", def?.title || key, `${key}_count`);
    } else {
      const p = draft.parameters.find((x) => x.key === ref.key);
      message = t("MODEL_DELETE_PARAM_MSG", p?.label || ref.key);
    }
    if (message === null || await confirm({ title: t("MODEL_DELETE"), message, actionText: t("MODEL_DELETE"), destructive: true }))
      update((d) => deleteNode(d, ref));
  };

  const saveTitle = (ref: RowRef, title: string) =>
    update((d) => ({
      ...d,
      structure: {
        sections: d.structure.sections.map((s, si) => {
          if (ref.kind === "section") return si === ref.s ? { ...s, title } : s;
          if (ref.kind === "group") return si === ref.s ? { ...s, groups: s.groups.map((g, gi) => (gi === ref.g && !isTableGroup(g) ? { ...g, title } : g)) } : s;
          return s;
        }),
      },
    }));

  const addKey = (base: string, taken: string[]) => {
    let k = base, n = 2;
    while (taken.includes(k)) k = `${base}${n++}`;
    return k;
  };
  const addSection = () => update((d) => ({
    ...d,
    structure: { sections: [...d.structure.sections, { key: addKey("section", d.structure.sections.map((s) => s.key)), title: copy(t, "MODEL_NEW_SECTION", "New section"), groups: [] }] },
  }));
  const addGroup = (s: number) => update((d) => ({
    ...d,
    structure: {
      sections: d.structure.sections.map((sec, i) => i !== s ? sec : {
        ...sec,
        groups: [...sec.groups, {
          key: addKey("group", sec.groups.flatMap((g) => (isTableGroup(g) ? [] : [g.key]))),
          title: copy(t, "MODEL_NEW_GROUP", "New group"), params: [],
        }],
      }),
    },
  }));
  const addFormula = () => update((d) => ({
    ...d,
    computed: [...d.computed, { key: addKey("value", [...d.parameters.map((p) => p.key), ...d.computed.map((c) => c.key)]), expr: "0" }],
  }));
  // A table is a group, so it is added to a section, not into one.
  const addTable = (role: "calc" | "items", s: number) => update((d) => {
    const table = role === "items" ? localizeItems(itemsTable(), t) : newCalcTable((d.tables ?? []).map((x) => x.key), t);
    return placeTable({ ...d, tables: [...(d.tables ?? []), table] }, table.key, s);
  });
  // checkModel allows at most one items table, and requires exactly one.
  const hasItems = (draft.tables ?? []).some((t) => t.role === "items");

  // Everything a row can do is a row action: UI5 shows the first `rowActionCount` in DOM order and
  // pushes the rest into its own overflow menu, which is why Delete sits second — it stays visible
  // on every row type while the rarer table adds fall into the menu.
  const del = <TableRowAction icon="delete" text={t("MODEL_DELETE")} data-act="delete" />;
  // The items grid is mandatory (checkModel enforces it), so it is the one row with no delete.
  const actionsFor = (ref: RowRef) =>
    ref.kind === "section" ? (
      <>
        <TableRowAction icon="add" text={t("MODEL_ADD_GROUP")} data-act="add" />
        {del}
        <TableRowAction icon="table-view" text={t("MODEL_ADD_CALC_TABLE")} data-act="calc" />
        {/* TableRowAction has no disabled state, so a second item grid is simply not offered. */}
        {hasItems ? null : <TableRowAction icon="product" text={t("MODEL_ADD_ITEM_GRID")} data-act="items" />}
      </>
    )
    : ref.kind === "group" ? <><TableRowAction icon="add" text={t("MODEL_ADD_PARAM")} data-act="add" />{del}</>
    : ref.kind === "table" ? (defOf(tableKeyAt(draft, ref.s, ref.g) ?? "")?.role === "items" ? undefined : del)
    : (
      <>
        <TableRowAction icon="add" text={t("MODEL_ADD_FORMULA")} data-act="add" />
        {del}
        <TableRowAction icon="copy" text={t("MODEL_DUPLICATE_PARAM")} data-act="dup" />
      </>
    );

  // ponytail: no responsive drop-below — the preview goes where the title-bar picker says, which
  // suits the desktop-only model builder. Wrap it in a DynamicSideContent if a tablet ever needs it.
  // Both panes scroll themselves: SplitterLayout clips (overflow:hidden), so the tree can no
  // longer lean on the ObjectPage's scroller.
  // Keyed, so moving the preview to the other side moves the pane instead of remounting it — the
  // values typed into it survive the switch.
  // A size of its own, not "auto": an auto pane measures itself once and freezes at that px, and
  // straight after a reset that measure can land before the layout settles — the preview then
  // stops short of the edge until a drag rewrites it. Two percentages always add up to the width.
  const preview = (
    <SplitterElement key="preview" size="50%" minSize={280}>
      <PreviewPane modelId={modelId ?? ""} draft={draft} issues={issues} lookups={lookups}
        lookupsFailed={lookupsFailed} onRetryLookups={onRetryLookups} />
    </SplitterElement>
  );
  const previewFirst = previewAt === "left" || previewAt === "top";
  return (
    // flex:1 + minHeight:0 is fitContent's contract (see the params section): fill the page height.
    // A drag writes px straight onto the panes, so a new arrangement — or a resized page, where
    // those px would leave a gap — resets to the declared sizes.
    // The inset is the splitter's margin, not padding on either pane: the section already pads
    // the top, and a pane padding would drop the structure card below the first preview Form.
    <SplitterLayout vertical={previewAt === "top" || previewAt === "bottom"}
      style={{ flex: 1, minHeight: 0, margin: "0 1rem 1rem" }}
      options={{ resetOnCustomDepsChange: [previewAt], resetOnSizeChange: true }}>
      {previewFirst ? preview : null}
      <SplitterElement key="tree" size={previewAt === "hidden" ? "100%" : "50%"} minSize={280}>
    <div style={{
      display: "flex", flexDirection: "column", gap: "0.75rem",
      flex: "1 1 auto", minInlineSize: 0, overflowY: "auto",
    }}>
      {/* Form's shell (.ui5-form-root) is the rounded card: 0.75rem and the group background.
          Table exposes no CSS part for its frame, so the title bar and the rows share this
          wrapper and overflow clips them to the curve. */}
      <div style={{
        display: "flex", flexDirection: "column",
        backgroundColor: "var(--sapGroup_ContentBackground)",
        borderRadius: "0.75rem", overflow: "hidden",
      }}>
      {/* Every other add lives on the row it adds into, so this is the only action with no row to
          hang it on. marginTop cancels the Subheader's -1px overlap, which the clip would shave. */}
      <Bar design="Subheader" style={{ borderBlockEnd: "none", marginTop: 0 }}
        startContent={<Title level="H5">{t("MODEL_FORM_STRUCTURE")}</Title>}
        endContent={<Button icon="add" onClick={addSection}>{t("MODEL_ADD_SECTION")}</Button>}
      />

      <Table
        accessibleName={t("MODEL_FORM_STRUCTURE")}
        className="confire-params-struct"
        noData={
          <IllustratedMessage name="AddColumn" design="Dot" titleText={t("MODEL_NO_STRUCTURE")}
            subtitleText={t("MODEL_NO_STRUCTURE_SUB")} />
        }
        rowActionCount={3}
        onMoveOver={(e) => {
          const src = (e.detail.source.element as HTMLElement | null)?.getAttribute("row-key");
          const dst = (e.detail.destination.element as HTMLElement | null)?.getAttribute("row-key");
          const placement = e.detail.destination.placement as Placement;
          // ponytail: formula rows (c:) share this table but aren't structure nodes — never a drag src/dst.
          if (src?.startsWith("c:") || dst?.startsWith("c:")) return;
          if (src && dst && canDrop(draft, src, dst, placement)) e.preventDefault();
        }}
        onMove={(e) => {
          const src = (e.detail.source.element as HTMLElement | null)?.getAttribute("row-key");
          const dst = (e.detail.destination.element as HTMLElement | null)?.getAttribute("row-key");
          const placement = e.detail.destination.placement as Placement;
          if (src?.startsWith("c:") || dst?.startsWith("c:")) return;
          if (src && dst) update((d) => applyMove(d, src, dst, placement));
        }}
        onRowActionClick={(e) => {
          const rowKey = ((e.detail.row as unknown) as HTMLElement).getAttribute("row-key")!;
          const act = ((e.detail.action as unknown) as HTMLElement).dataset.act;
          if (rowKey.startsWith("c:")) {
            const i = Number(rowKey.slice(2));
            if (act === "delete") {
              setFEdit(null);
              update((d) => ({ ...d, computed: d.computed.filter((_, j) => j !== i) }));
            } else addFormula();
            return;
          }
          const ref = parseRowKey(rowKey);
          if (act === "delete") void confirmDelete(ref);
          else if (act === "calc" || act === "items") { if (ref.kind === "section") addTable(act, ref.s); }
          else if (act === "dup" && ref.kind === "param") update((d) => duplicateParam(d, ref.key));
          else if (ref.kind === "section") addGroup(ref.s);
          else if (ref.kind === "group") openParam({ s: ref.s, g: ref.g });
          else if (ref.kind === "param") addFormula();
        }}
        onRowClick={(e) => {
          const rowKey = ((e.detail.row as unknown) as HTMLElement).getAttribute("row-key")!;
          if (rowKey.startsWith("c:")) return setFEdit(Number(rowKey.slice(2)));
          const ref = parseRowKey(rowKey);
          if (ref.kind === "table") {
            setTableEdit(tableKeyAt(draft, ref.s, ref.g) ?? null);
          } else if (ref.kind === "param") {
            const p = draft.parameters.find((x) => x.key === ref.key);
            if (p) openParam({ key: p.key });
          } else {
            const sec = draft.structure.sections[ref.s];
            const grp = ref.kind === "group" ? sec?.groups[ref.g] : undefined;
            setTitleEdit({
              ref,
              initial: ref.kind === "section" ? sec?.title ?? "" : grp && !isTableGroup(grp) ? grp.title : "",
            });
          }
        }}
        headerRow={
          <TableHeaderRow ref={onHeader}>
            <TableHeaderCell width="45%"><span>{t("MODEL_STRUCTURE")}</span></TableHeaderCell>
            <TableHeaderCell><span>{t("MODEL_DETAILS")}</span></TableHeaderCell>
          </TableHeaderRow>
        }
      >
        {rows.map((r) =>
          r.kind === "formula" ? (
            // Read-only until clicked: a row of live Inputs is taller than a row of Text, and that
            // gap is what made the formula block look bolted on.
            <TableRow key={r.key} rowKey={r.key} interactive
              actions={<><TableRowAction icon="add" text={t("MODEL_ADD_FORMULA")} data-act="add" />{del}</>}>
              <TableCell>
                <Gutter depth={3}>
                  <span style={{ color: "var(--sapContent_LabelColor)", fontStyle: "italic", flex: "0 0 auto" }}>ƒ</span>
                  {fEdit === r.idx ? (
                    <Input accessibleName={t("MODEL_FORMULA_KEY")} style={{ width: "100%" }} value={draft.computed[r.idx]!.key} autoFocus
                      onInput={(e) => update((d) => ({ ...d, computed: d.computed.map((x, j) => (j === r.idx ? { ...x, key: e.target.value } : x)) }))} />
                  ) : (
                    <Text>{draft.computed[r.idx]!.key}</Text>
                  )}
                </Gutter>
              </TableCell>
              <TableCell>
                <div style={{ width: "100%" }}>
                  {fEdit === r.idx ? (
                    <ExprInput value={draft.computed[r.idx]!.expr} model={draft} tables={tables} fieldId={`expr-computed[${r.idx}].expr`}
                      issue={issueFor(issues, `computed[${r.idx}].expr`)}
                      onChange={(v) => update((d) => ({ ...d, computed: d.computed.map((x, j) => (j === r.idx ? { ...x, expr: v ?? "" } : x)) }))} />
                  ) : (
                    <Text style={{ color: issueFor(issues, `computed[${r.idx}].expr`) ? "var(--sapNegativeColor)" : undefined }}>
                      {`= ${draft.computed[r.idx]!.expr}`}
                    </Text>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ) : (
            <TableRow key={r.key} rowKey={r.key} movable interactive actions={actionsFor(r.ref)}>
              <TableCell>
                <Gutter depth={r.depth} collapse={r.collapseId
                  ? { collapsed: collapsed.has(r.collapseId), onToggle: () => toggle(r.collapseId!) }
                  : undefined}>
                  {r.ref.kind === "table" ? (
                    <span style={{ color: "var(--sapContent_LabelColor)", flex: "0 0 auto" }} aria-hidden>▦</span>
                  ) : null}
                  <Text style={{ fontWeight: r.depth === 0 ? "bold" : "normal" }}>{r.label}</Text>
                </Gutter>
              </TableCell>
              <TableCell><Text>{r.detail}</Text></TableCell>
            </TableRow>
          ),
        )}
      </Table>
      </div>

      {tableEdit && defOf(tableEdit) ? (
        <TableDialog
          draft={draft} tables={tables} initial={defOf(tableEdit)!}
          onCancel={() => setTableEdit(null)}
          onOk={(t) => {
            const was = tableEdit;
            update((d) => ({
              ...d,
              tables: (d.tables ?? []).map((x) => (x.key === was ? t : x)),
              // a rename has to follow into placement, or the group points at a table that is gone
              structure: was === t.key ? d.structure : {
                sections: d.structure.sections.map((sec) => ({
                  ...sec,
                  groups: sec.groups.map((g) => (isTableGroup(g) && g.table === was ? { table: t.key } : g)),
                })),
              },
            }));
            setTableEdit(null);
          }}
        />
      ) : null}

      {titleEdit ? (
        <TitleDialog initial={titleEdit.initial} section={titleEdit.ref.kind === "section"}
          onCancel={() => setTitleEdit(null)}
          onOk={(v) => { saveTitle(titleEdit.ref, v); setTitleEdit(null); }} />
      ) : null}

    </div>
      </SplitterElement>
      {previewFirst || previewAt === "hidden" ? null : preview}
    </SplitterLayout>
  );
}

// SplitterLayout is a React component, not a web component — no `slot` to forward, unlike
// DynamicSideContent's `sideContent`.
function PreviewPane({ modelId, draft, issues, lookups, lookupsFailed, onRetryLookups }: {
  modelId: string; draft: ModelDef; issues: Issue[];
  lookups?: ResolvedLookups; lookupsFailed?: boolean; onRetryLookups: () => void;
}) {
  const i18n = useI18n();
  const [entries, setEntries] = useState<Entries>({});
  const [tables, setTables] = useState<TableRows>({});
  const lastGood = useRef(draft);
  if (issues.length === 0) lastGood.current = draft;
  const previewModel = issues.length === 0 ? draft : lastGood.current;
  // The one place the engine still runs in the browser: an unsaved model has no row on the server,
  // and nothing previewed here is stored or quoted. Same form state the server builds, so the form
  // has one input shape. ponytail: a value picked off a query field's first page binds no derived
  // columns here (the server binds them from the stored entry); a preview has none stored.
  const form = lookups ? formState(previewModel, lookups, propagate(previewModel, lookups, entries, tables), tables) : null;

  return (
    <div style={{ flex: "1 1 auto", minInlineSize: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* Why the preview is empty is a page message; the retry it needs is not something a
          message can carry, so the button stays here. */}
      {lookupsFailed ? (
        <div style={{ padding: "0.5rem 1rem" }}>
          <Button icon="refresh" onClick={onRetryLookups}>{i18n.getText("MODEL_RETRY_OPTIONS")}</Button>
        </div>
      ) : null}
      {/* The configuration page's sections and anchor bar, in a title-less ObjectPage that scrolls itself. */}
      {lookups && form ? (
        <ObjectPage hidePinButton style={{ flex: 1, minHeight: 0 }}>
          {configuratorSections({
            model: previewModel, form, tables: lookups.tables, formulaOverride: true,
            onChange: (key, v) => setEntries((e) => setEntry(e, key, v)),
            querySource: { modelId },
            rows: tables, onRowsChange: (key, rows) => setTables((cur) => ({ ...cur, [key]: rows })),
          })}
        </ObjectPage>
      ) : lookupsFailed ? null : <BusyIndicator active delay={0} />}
    </div>
  );
}
