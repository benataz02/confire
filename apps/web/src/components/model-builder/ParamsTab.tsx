import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Bar, Button, BusyIndicator, IllustratedMessage, Input,
  SplitterElement, SplitterLayout, Table, TableCell, TableHeaderCell,
  TableHeaderRow, TableRow, TableRowAction, Text, Title,
  type TableHeaderRowDomRef,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/AddColumn.js";
import { isTableGroup, itemsTable, propagate, type Entries, type ResolvedLookups, type TableRows } from "@confire/config-engine";
import type { Issue, ModelDef, Param, TableDef } from "@confire/config-engine";
import { confirm } from "../confirm.ts";
import { ExprInput } from "./ExprInput.tsx";
import { ParamDialog } from "./ParamDialog.tsx";
import { TableDialog, newCalcTable } from "./TableDialog.tsx";
import type { TableCols } from "./exprHelpers.ts";
import { ConfiguratorForm } from "../configurator/ConfiguratorForm.tsx";
import { mergeQueryPicks, setQueryPick, type QueryPicks } from "../configurator/formHelpers.ts";
import { issueFor } from "./useDraftModel.ts";
import { applyMove, canDrop, deleteNode, duplicateParam, parseRowKey, placeParam, placeTable, rowKeyOf, tableKeyAt, type Placement, type RowRef } from "./structureOps.ts";

type Tables = TableCols[];
type Update = (fn: (d: ModelDef) => ModelDef) => void;

// mandatory by default: an unanswered field is the usual mistake, and unticking it is one click.
const emptyParam = (): Param => ({ key: "", label: "", type: "string", ui: "select", mandatory: true });

// UI5 cozy icon-button min width — reserved so leaf labels indent past group labels.
const TOGGLE = "2.25rem";

function Gutter({ depth, children, collapse, style }: {
  depth: number;
  children: ReactNode;
  collapse?: { collapsed: boolean; onToggle: () => void };
  style?: CSSProperties;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.25rem", paddingInlineStart: `${depth * 1.5}rem`, ...style }}>
      {collapse ? (
        // Chevron is a real button, indented with the level; stopPropagation so a toggle never enters edit (onRowClick).
        <Button design="Transparent" style={{ flex: "0 0 auto" }}
          icon={collapse.collapsed ? "slim-arrow-right" : "slim-arrow-down"}
          tooltip={collapse.collapsed ? "Expand" : "Collapse"}
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
function revealActionsHeader(el: TableHeaderRowDomRef | null) {
  const sr = el?.shadowRoot;
  if (!sr || sr.getElementById("confire-actions-hdr")) return;
  const style = document.createElement("style");
  style.id = "confire-actions-hdr";
  style.textContent = `#actions-cell-content{position:static;clip:auto;font-size:0}#actions-cell-content::after{content:"Actions";font-size:var(--sapFontSize);font-family:var(--sapFontSemiboldDuplexFamily);color:var(--sapList_HeaderTextColor)}`;
  sr.appendChild(style);
}

export function ParamsTab({ modelId, draft, update, issues, tables, lookups, lookupsFailed, onRetryLookups }: {
  modelId: string; draft: ModelDef; update: Update; issues: Issue[]; tables: Tables;
  lookups?: ResolvedLookups; lookupsFailed?: boolean; onRetryLookups: () => void;
}) {
  const [editing, setEditing] = useState<{ param: Param; isNew: boolean; place?: { s: number; g: number } } | null>(null);
  // Table being edited in the dialog, by key — the dialog buffers its own copy.
  const [tableEdit, setTableEdit] = useState<string | null>(null);
  // Formula row switched to its live editors; every other row shows read-only text, which is the
  // whole reason the rows are the same height.
  const [fEdit, setFEdit] = useState<number | null>(null);
  // Inline title edit: keep the original so Escape can revert (edits apply live per keystroke).
  const [titleEdit, setTitleEdit] = useState<{ key: string; original: string } | null>(null);
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
    rows.push({ kind: "struct", key: rowKeyOf({ kind: "section", s: si }), depth: 0, label: s.title, detail: `section · ${s.key}`, ref: { kind: "section", s: si }, collapseId: sId });
    if (collapsed.has(sId)) return;
    s.groups.forEach((g, gi) => {
      // A table is a group, so it draws at group depth with no children and no collapse chevron.
      if (isTableGroup(g)) {
        const t = defOf(g.table);
        rows.push({
          kind: "struct", key: rowKeyOf({ kind: "table", s: si, g: gi }), depth: 1, label: t?.title || g.table,
          detail: t
            ? `${t.role === "items" ? "item grid" : "calculation table"} · ${t.columns.length} column${t.columns.length === 1 ? "" : "s"}`
            : "missing table",
          ref: { kind: "table", s: si, g: gi },
        });
        return;
      }
      const gId = `G:${s.key}/${g.key}`;
      rows.push({ kind: "struct", key: rowKeyOf({ kind: "group", s: si, g: gi }), depth: 1, label: g.title, detail: `group · ${g.key}`, ref: { kind: "group", s: si, g: gi }, collapseId: gId });
      if (collapsed.has(gId)) return;
      g.params.forEach((k) => {
        const p = draft.parameters.find((x) => x.key === k);
        const own = k === lastParam ? formulas : [];
        const pId = `P:${k}`;
        rows.push({
          kind: "struct", key: rowKeyOf({ kind: "param", key: k }), depth: 2, label: p?.label || k,
          detail: p ? `${p.type} · ${p.ui}${p.domain ? (p.domain.kind === "range" ? " · range" : ` · ${p.domain.ref.source}`) : ""}${p.excludeFromDomains ? " · excluded" : ""}` : "missing definition",
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

  const saveParam = (p: Param, isNew: boolean, place?: { s: number; g: number }) =>
    update((d) => {
      const parameters = isNew
        ? [...d.parameters, p]
        : d.parameters.map((x) => (x.key === editing!.param.key || x.key === p.key ? p : x));
      let out = { ...d, parameters };
      if (isNew && place) out = placeParam(out, p.key, place.s, place.g);
      return out;
    });

  // Confirm only when a delete is destructive: a section/group with children (cascades), or a
  // parameter (drops its whole definition). Empty sections/groups delete without a prompt.
  const confirmDelete = async (ref: RowRef) => {
    let message: string | null = null;
    if (ref.kind === "section") {
      const sec = draft.structure.sections[ref.s];
      const groups = sec?.groups.length ?? 0;
      const params = sec?.groups.reduce((n, g) => n + (isTableGroup(g) ? 0 : g.params.length), 0) ?? 0;
      if (groups > 0) message = `Delete section "${sec?.title}" with its ${groups} group${groups === 1 ? "" : "s"}${params ? ` and ${params} placed parameter${params === 1 ? "" : "s"}` : ""}?`;
    } else if (ref.kind === "group") {
      const grp = draft.structure.sections[ref.s]?.groups[ref.g];
      const params = grp && !isTableGroup(grp) ? grp.params.length : 0;
      if (params) message = `Delete group "${grp && !isTableGroup(grp) ? grp.title : ""}" and its ${params} parameter${params === 1 ? "" : "s"}?`;
    } else if (ref.kind === "table") {
      const key = tableKeyAt(draft, ref.s, ref.g) ?? "";
      const t = defOf(key);
      message = `Delete table "${t?.title || key}"? Formulas reading ${key}_count or its column sums will stop resolving.`;
    } else {
      const p = draft.parameters.find((x) => x.key === ref.key);
      message = `Delete parameter "${p?.label || ref.key}"? This removes its definition from the model.`;
    }
    if (message === null || await confirm({ title: "Delete", message, actionText: "Delete", destructive: true }))
      update((d) => deleteNode(d, ref));
  };

  const setTitle = (ref: RowRef, title: string) =>
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
    structure: { sections: [...d.structure.sections, { key: addKey("section", d.structure.sections.map((s) => s.key)), title: "New section", groups: [] }] },
  }));
  const addGroup = (s: number) => update((d) => ({
    ...d,
    structure: {
      sections: d.structure.sections.map((sec, i) => i !== s ? sec : {
        ...sec,
        groups: [...sec.groups, {
          key: addKey("group", sec.groups.flatMap((g) => (isTableGroup(g) ? [] : [g.key]))),
          title: "New group", params: [],
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
    const t = role === "items" ? itemsTable() : newCalcTable((d.tables ?? []).map((x) => x.key));
    return placeTable({ ...d, tables: [...(d.tables ?? []), t] }, t.key, s);
  });
  // checkModel allows at most one items table, and requires exactly one.
  const hasItems = (draft.tables ?? []).some((t) => t.role === "items");

  // Everything a row can do is a row action: UI5 shows the first `rowActionCount` in DOM order and
  // pushes the rest into its own overflow menu, which is why Delete sits second — it stays visible
  // on every row type while the rarer table adds fall into the menu.
  const del = <TableRowAction icon="delete" text="Delete" data-act="delete" />;
  // The items grid is mandatory (checkModel enforces it), so it is the one row with no delete.
  const actionsFor = (ref: RowRef) =>
    ref.kind === "section" ? (
      <>
        <TableRowAction icon="add" text="Add group" data-act="add" />
        {del}
        <TableRowAction icon="table-view" text="Add calculation table" data-act="calc" />
        {/* TableRowAction has no disabled state, so a second item grid is simply not offered. */}
        {hasItems ? null : <TableRowAction icon="product" text="Add item grid" data-act="items" />}
      </>
    )
    : ref.kind === "group" ? <><TableRowAction icon="add" text="Add parameter" data-act="add" />{del}</>
    : ref.kind === "table" ? (defOf(tableKeyAt(draft, ref.s, ref.g) ?? "")?.role === "items" ? undefined : del)
    : (
      <>
        <TableRowAction icon="add" text="Add formula" data-act="add" />
        {del}
        <TableRowAction icon="copy" text="Duplicate parameter" data-act="dup" />
      </>
    );

  // ponytail: no responsive drop-below — SplitterLayout is desktop-only, which the model builder
  // is. Wrap it in a DynamicSideContent again if a tablet ever has to open this tab.
  // Both panes scroll themselves: SplitterLayout clips (overflow:hidden), so the tree can no
  // longer lean on the ObjectPage's scroller.
  return (
    <SplitterLayout style={{ height: "100%", minHeight: "28rem" }}>
      <SplitterElement size="50%" minSize={280}>
    <div style={{
      display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem",
      flex: "1 1 auto", minInlineSize: 0, overflowY: "auto",
    }}>
      <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Every other add lives on the row it adds into, so this is the only action with no row to
          hang it on. */}
      <Bar design="Subheader" style={{ borderBlockEnd: "none" }}
        startContent={<Title level="H5">Form structure</Title>}
        endContent={<Button icon="add" onClick={addSection}>Add section</Button>}
      />

      <Table
        accessibleName="Form structure"
        className="confire-params-struct"
        noData={
          <IllustratedMessage name="AddColumn" design="Dot" titleText="No structure yet"
            subtitleText="Add a section to start structuring the form, then add groups and parameters." />
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
          else if (ref.kind === "group") setEditing({ param: emptyParam(), isNew: true, place: { s: ref.s, g: ref.g } });
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
            if (p) setEditing({ param: structuredClone(p), isNew: false });
          } else {
            const grp = ref.kind === "group" ? draft.structure.sections[ref.s]?.groups[ref.g] : undefined;
            const title = ref.kind === "section" ? draft.structure.sections[ref.s]?.title ?? ""
              : grp && !isTableGroup(grp) ? grp.title : "";
            setTitleEdit({ key: rowKeyOf(ref), original: title });
          }
        }}
        headerRow={
          <TableHeaderRow ref={revealActionsHeader}>
            <TableHeaderCell width="45%"><span>Structure</span></TableHeaderCell>
            <TableHeaderCell><span>Details</span></TableHeaderCell>
          </TableHeaderRow>
        }
      >
        {rows.map((r) =>
          r.kind === "formula" ? (
            // Read-only until clicked: a row of live Inputs is taller than a row of Text, and that
            // gap is what made the formula block look bolted on.
            <TableRow key={r.key} rowKey={r.key} interactive
              actions={<><TableRowAction icon="add" text="Add formula" data-act="add" />{del}</>}>
              <TableCell>
                <Gutter depth={3}>
                  <span style={{ color: "var(--sapContent_LabelColor)", fontStyle: "italic", flex: "0 0 auto" }}>ƒ</span>
                  {fEdit === r.idx ? (
                    <Input accessibleName="Formula key" style={{ width: "100%" }} value={draft.computed[r.idx]!.key} autoFocus
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
                  {titleEdit?.key === r.key && (r.ref.kind === "section" || r.ref.kind === "group") ? (
                    <Input
                      accessibleName="Title"
                      value={r.label}
                      autoFocus
                      onBlur={() => setTitleEdit(null)}
                      // Enter commits (edits already applied live); Escape reverts to the original title.
                      onKeyDown={(e) => {
                        if (e.key === "Enter") setTitleEdit(null);
                        else if (e.key === "Escape") { setTitle(r.ref, titleEdit.original); setTitleEdit(null); }
                      }}
                      onInput={(e) => setTitle(r.ref, e.target.value)}
                    />
                  ) : (
                    <Text style={{ fontWeight: r.depth === 0 ? "bold" : "normal" }}>{r.label}</Text>
                  )}
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

      {editing ? (
        <ParamDialog
          draft={draft} tables={tables} initial={editing.param} isNew={editing.isNew}
          onCancel={() => setEditing(null)}
          onOk={(p) => { saveParam(p, editing.isNew, editing.place); setEditing(null); }}
        />
      ) : null}
    </div>
      </SplitterElement>
      <SplitterElement minSize={280}>
        <PreviewPane modelId={modelId} draft={draft} issues={issues} lookups={lookups}
          lookupsFailed={lookupsFailed} onRetryLookups={onRetryLookups} />
      </SplitterElement>
    </SplitterLayout>
  );
}

// SplitterLayout is a React component, not a web component — no `slot` to forward, unlike
// DynamicSideContent's `sideContent`.
function PreviewPane({ modelId, draft, issues, lookups, lookupsFailed, onRetryLookups }: {
  modelId: string; draft: ModelDef; issues: Issue[];
  lookups?: ResolvedLookups; lookupsFailed?: boolean; onRetryLookups: () => void;
}) {
  const [entries, setEntries] = useState<Entries>({});
  const [tables, setTables] = useState<TableRows>({});
  const [picks, setPicks] = useState<QueryPicks>({});
  const lastGood = useRef(draft);
  if (issues.length === 0) lastGood.current = draft;
  const previewModel = issues.length === 0 ? draft : lastGood.current;
  const lk = lookups ? mergeQueryPicks(lookups, picks) : undefined;
  const prop = lk ? propagate(previewModel, lk, entries, tables) : null;

  return (
    <div style={{ flex: "1 1 auto", minInlineSize: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* Why the preview is empty is a page message; the retry it needs is not something a
          message can carry, so the button stays here. */}
      {lookupsFailed ? (
        <div style={{ padding: "0.5rem 1rem" }}>
          <Button icon="refresh" onClick={onRetryLookups}>Retry loading options</Button>
        </div>
      ) : null}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "0 1rem 1rem" }}>
        {lookups && lk && prop ? (
          <ConfiguratorForm model={previewModel} lookups={lookups} lk={lk} prop={prop} entries={entries} onChange={setEntries}
            onQueryPick={(k, t, sel) => setPicks((p) => setQueryPick(p, k, t, sel))}
            querySource={{ kind: "project", modelId }}
            tables={tables} onTablesChange={setTables} />
        ) : lookupsFailed ? null : <BusyIndicator active delay={0} />}
      </div>
    </div>
  );
}
