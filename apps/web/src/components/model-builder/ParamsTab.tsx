import { useRef, useState } from "react";
import {
  Bar, Button, BusyIndicator, IllustratedMessage, Input,
  Menu, MenuItem, MessageStrip, SplitButton, SplitterElement, SplitterLayout,
  Title, Tree, TreeItem, TreeItemCustom,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/AddColumn.js";
import { isTableGroup, itemsTable, propagate, type Entries, type ResolvedLookups, type TableRows } from "@confire/config-engine";
import type { FieldGroup, Issue, ModelDef, Param, TableDef, TableGroup } from "@confire/config-engine";
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
type Section = ModelDef["structure"]["sections"][number];

// mandatory by default: an unanswered field is the usual mistake, and unticking it is one click.
const emptyParam = (): Param => ({ key: "", label: "", type: "string", ui: "select", mandatory: true });

// Every item carries its own key as data-key: `rowKeyOf` for a structure node, `c:<i>` for a
// formula. Tree hands the item element back on move/click/toggle, so one attribute addresses them
// all and `parseRowKey` stays the only thing that knows the format.
const keyOf = (el: unknown) => (el as HTMLElement | null)?.dataset.key;

// Menu opener is resolved by id, so a row key has to survive as one.
const openerId = (rowKey: string) => `pt-add-${rowKey.replace(/[^\w-]/g, "_")}`;

export function ParamsTab({ modelId, draft, update, issues, tables, lookups, lookupsError, onRetryLookups }: {
  modelId: string; draft: ModelDef; update: Update; issues: Issue[]; tables: Tables;
  lookups?: ResolvedLookups; lookupsError?: Error | null; onRetryLookups: () => void;
}) {
  const [editing, setEditing] = useState<{ param: Param; isNew: boolean; place?: { s: number; g: number } } | null>(null);
  // Table being edited in the dialog, by key — the dialog buffers its own copy.
  const [tableEdit, setTableEdit] = useState<string | null>(null);
  // Formula row switched to its live editors; every other row shows read-only text, which is the
  // whole reason the rows are the same height.
  const [fEdit, setFEdit] = useState<number | null>(null);
  // Inline title edit: keep the original so Escape can revert (edits apply live per keystroke).
  const [titleEdit, setTitleEdit] = useState<{ key: string; original: string } | null>(null);
  // The one row whose add-arrow is open, and the button that opened it.
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  // Keyed by stable section/group/param key (not row index) so collapse survives drag-reordering.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((c) => { const n = new Set(c); n.delete(id) || n.add(id); return n; });

  const defOf = (k: string): TableDef | undefined => (draft.tables ?? []).find((t) => t.key === k);

  // A formula is global; `under` only says which parameter it is drawn beneath — which is exactly
  // what nesting it under that parameter's node expresses. Nothing is ever left dangling: an anchor
  // naming a parameter that is gone or unplaced re-homes onto the last placed one, which is also
  // where a new formula goes.
  const placedParams = draft.structure.sections
    .flatMap((s) => s.groups.flatMap((g) => (isTableGroup(g) ? [] : g.params)));
  const lastParam = placedParams.at(-1);
  const anchorFor = (under?: string) => (under && placedParams.includes(under) ? under : lastParam);
  const byAnchor = new Map<string, number[]>();
  draft.computed.forEach((c, i) => {
    const at = anchorFor(c.under) ?? "";
    byAnchor.set(at, [...(byAnchor.get(at) ?? []), i]);
  });

  // Model-level issues have no row of their own (duplicate key, computed cycle, bad structure ref).
  const modelIssues = issues.filter((i) => i.path === "model" || i.path === "computed" || i.path === "structure");

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
  const addFormula = (under?: string) => update((d) => ({
    ...d,
    computed: [...d.computed, { key: addKey("value", [...d.parameters.map((p) => p.key), ...d.computed.map((c) => c.key)]), expr: "0", under }],
  }));
  // A table is a group, so it is added to a section, not into one.
  const addTable = (role: "calc" | "items", s: number) => update((d) => {
    const t = role === "items" ? itemsTable() : newCalcTable((d.tables ?? []).map((x) => x.key));
    return placeTable({ ...d, tables: [...(d.tables ?? []), t] }, t.key, s);
  });
  // checkModel allows at most one items table, and requires exactly one — so the menu entry that
  // would create a second is disabled rather than producing a model that cannot be saved.
  const hasItems = (draft.tables ?? []).some((t) => t.role === "items");

  // Trailing add/delete live in Tree's Delete-mode `deleteButton` slot — that's the standard
  // TreeItem end-content, so rows can stay `text` + `additionalText` instead of a custom body.
  // SplitButton only where the arrow has a real menu; a plain Button everywhere else.
  //
  // No stopPropagation anywhere: ListItemBase._onclick bails on `:has(:focus-within)`, so a focused
  // slotted control already suppresses the row's own click.
  const addBtn = (rowKey: string, tip: string, onClick: () => void, menu?: boolean) =>
    menu ? (
      <SplitButton key="add" id={openerId(rowKey)} icon="add" design="Transparent"
        accessibleName={tip}
        accessibilityAttributes={{ root: { title: tip }, arrowButton: { hasPopup: "menu", expanded: rowMenu === rowKey } }}
        onClick={onClick}
        onArrowClick={() => setRowMenu(rowKey)} />
    ) : (
      <Button key="add" icon="add" design="Transparent" tooltip={tip} onClick={onClick} />
    );
  const delBtn = (tip: string, onClick: () => void) => (
    <Button key="del" icon="delete" design="Transparent" tooltip={tip} onClick={onClick} />
  );

  const actionsFor = (ref: RowRef) => {
    const rowKey = rowKeyOf(ref);
    if (ref.kind === "section")
      return <>{addBtn(rowKey, "Add group", () => addGroup(ref.s), true)}{delBtn("Delete section", () => void confirmDelete(ref))}</>;
    if (ref.kind === "group")
      return <>{addBtn(rowKey, "Add parameter", () => setEditing({ param: emptyParam(), isNew: true, place: { s: ref.s, g: ref.g } }))}{delBtn("Delete group", () => void confirmDelete(ref))}</>;
    if (ref.kind === "table")
      // Delete mode always paints the slot; hide it for the mandatory items grid.
      return defOf(tableKeyAt(draft, ref.s, ref.g) ?? "")?.role === "items"
        ? <Button key="del" design="Transparent" disabled style={{ display: "none" }} />
        : delBtn("Delete table", () => void confirmDelete(ref));
    return <>{addBtn(rowKey, "Add formula here", () => addFormula(ref.key), true)}{delBtn("Delete parameter", () => void confirmDelete(ref))}</>;
  };

  // TreeItem only takes string `text`, so rename swaps that one row to TreeItemCustom. The Input
  // keeps its own typing: ListItemBase._onclick/_onkeyup bail on `:has(:focus-within)`.
  const titleInput = (ref: RowRef, title: string) => (
    <Input
      accessibleName="Title"
      value={title}
      style={{ width: "100%" }}
      autoFocus
      onBlur={() => setTitleEdit(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") setTitleEdit(null);
        else if (e.key === "Escape" && titleEdit) { setTitle(ref, titleEdit.original); setTitleEdit(null); }
      }}
      onInput={(e) => setTitle(ref, e.target.value)}
    />
  );

  // A formula is global; nesting it under its anchor parameter is exactly what `under` means.
  // Never movable, and the `c:` guard keeps it out of every drop as a destination too.
  const formulaItem = (i: number) => {
    const c = draft.computed[i]!;
    const issue = issueFor(issues, `computed[${i}].expr`);
    const actions = (
      <>
        <Button key="add" icon="add" design="Transparent" tooltip="Add formula"
          onClick={() => addFormula(anchorFor(c.under))} />
        <Button key="del" icon="delete" design="Transparent" tooltip="Delete formula"
          onClick={() => { setFEdit(null); update((d) => ({ ...d, computed: d.computed.filter((_, j) => j !== i) })); }} />
      </>
    );
    if (fEdit === i) {
      return (
        <TreeItemCustom key={`c:${i}`} data-key={`c:${i}`} icon="sum" deleteButton={actions}
          content={
            <div style={{ alignItems: "center", display: "flex", gap: "0.5rem", width: "100%", minInlineSize: 0 }}>
              <Input accessibleName="Formula key" style={{ width: "8rem", flex: "0 0 auto" }} value={c.key} autoFocus
                onInput={(e) => update((d) => ({ ...d, computed: d.computed.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) }))} />
              <ExprInput value={c.expr} model={draft} tables={tables} fieldId={`expr-computed[${i}].expr`} issue={issue}
                style={{ flex: "1 1 auto", minInlineSize: 0 }}
                onChange={(v) => update((d) => ({ ...d, computed: d.computed.map((x, j) => (j === i ? { ...x, expr: v ?? "" } : x)) }))} />
            </div>
          }
        />
      );
    }
    return (
      <TreeItem key={`c:${i}`} data-key={`c:${i}`} icon="sum" text={c.key}
        additionalText={`= ${c.expr}`} additionalTextState={issue ? "Negative" : undefined}
        deleteButton={actions} />
    );
  };

  const paramItem = (k: string) => {
    const ref: RowRef = { kind: "param", key: k };
    const rowKey = rowKeyOf(ref);
    const p = draft.parameters.find((x) => x.key === k);
    const id = `P:${k}`;
    const detail = p
      ? `${p.type} · ${p.ui}${p.domain ? (p.domain.kind === "range" ? " · range" : ` · ${p.domain.ref.source}`) : ""}${p.excludeFromDomains ? " · excluded" : ""}`
      : "missing definition";
    return (
      <TreeItem key={rowKey} data-key={rowKey} data-collapse={id} movable expanded={!collapsed.has(id)}
        text={p?.label || k} additionalText={detail} additionalTextState={p ? undefined : "Negative"}
        deleteButton={actionsFor(ref)}>
        {(byAnchor.get(k) ?? []).map(formulaItem)}
      </TreeItem>
    );
  };

  // A table is a group, so it draws at group depth — with no children and, being addressed by the
  // table it names rather than a title of its own, no inline rename either.
  const tableItem = (g: TableGroup, si: number, gi: number) => {
    const ref: RowRef = { kind: "table", s: si, g: gi };
    const rowKey = rowKeyOf(ref);
    const t = defOf(g.table);
    const detail = t
      ? `${t.role === "items" ? "item grid" : "calculation table"} · ${t.columns.length} column${t.columns.length === 1 ? "" : "s"}`
      : "missing table";
    return (
      <TreeItem key={rowKey} data-key={rowKey} movable
        icon={t?.role === "items" ? "product" : "table-view"}
        text={t?.title || g.table} additionalText={detail} additionalTextState={t ? undefined : "Negative"}
        deleteButton={actionsFor(ref)} />
    );
  };

  const groupItem = (g: FieldGroup, si: number, gi: number, sectionKey: string) => {
    const ref: RowRef = { kind: "group", s: si, g: gi };
    const rowKey = rowKeyOf(ref);
    const id = `G:${sectionKey}/${g.key}`;
    return titleEdit?.key === rowKey ? (
      <TreeItemCustom key={rowKey} data-key={rowKey} data-collapse={id} movable expanded={!collapsed.has(id)}
        deleteButton={actionsFor(ref)} content={titleInput(ref, g.title)}>
        {g.params.map(paramItem)}
      </TreeItemCustom>
    ) : (
      <TreeItem key={rowKey} data-key={rowKey} data-collapse={id} movable expanded={!collapsed.has(id)}
        text={g.title} additionalText={`group · ${g.key}`} deleteButton={actionsFor(ref)}>
        {g.params.map(paramItem)}
      </TreeItem>
    );
  };

  const sectionItem = (s: Section, si: number) => {
    const ref: RowRef = { kind: "section", s: si };
    const rowKey = rowKeyOf(ref);
    const id = `S:${s.key}`;
    const kids = s.groups.map((g, gi) => (isTableGroup(g) ? tableItem(g, si, gi) : groupItem(g, si, gi, s.key)));
    return titleEdit?.key === rowKey ? (
      <TreeItemCustom key={rowKey} data-key={rowKey} data-collapse={id} movable expanded={!collapsed.has(id)}
        deleteButton={actionsFor(ref)} content={titleInput(ref, s.title)}>
        {kids}
      </TreeItemCustom>
    ) : (
      <TreeItem key={rowKey} data-key={rowKey} data-collapse={id} movable expanded={!collapsed.has(id)}
        text={s.title} additionalText={`section · ${s.key}`} deleteButton={actionsFor(ref)}>
        {kids}
      </TreeItem>
    );
  };

  // Only reachable with no parameter placed anywhere — there is no row to hang them under.
  const orphanFormulas = byAnchor.get("") ?? [];
  const empty = draft.structure.sections.length === 0 && orphanFormulas.length === 0;
  const menuRef = rowMenu ? parseRowKey(rowMenu) : null;

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
      {modelIssues.length ? (
        <MessageStrip design="Negative" hideCloseButton>
          {modelIssues.map((i) => i.message).join(" · ")}
        </MessageStrip>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Every other add lives on the row it adds into, so this is the only action with no row to
          hang it on. */}
      <Bar design="Subheader" style={{ borderBlockEnd: "none" }}
        startContent={<Title level="H5">Form structure</Title>}
        endContent={<Button icon="add" onClick={addSection}>Add section</Button>}
      />

      {empty ? (
        <IllustratedMessage name="AddColumn" design="Dot" titleText="No structure yet"
          subtitleText="Add a section to start structuring the form, then add groups and parameters." />
      ) : (
        <Tree
          accessibleName="Form structure"
          selectionMode="Delete"
          onItemDelete={(e) => {
            const rowKey = keyOf(e.detail.item);
            if (!rowKey) return;
            if (rowKey.startsWith("c:")) {
              const i = Number(rowKey.slice(2));
              setFEdit(null);
              update((d) => ({ ...d, computed: d.computed.filter((_, j) => j !== i) }));
              return;
            }
            const ref = parseRowKey(rowKey);
            if (ref.kind === "table" && defOf(tableKeyAt(draft, ref.s, ref.g) ?? "")?.role === "items") return;
            void confirmDelete(ref);
          }}
          onMoveOver={(e) => {
            const src = keyOf(e.detail.source.element);
            const dst = keyOf(e.detail.destination.element);
            const placement = e.detail.destination.placement as Placement;
            // ponytail: formula rows (c:) are drawn in this tree but aren't structure nodes. They
            // are never movable, and Tree._getItems() walks every rendered item regardless, so this
            // still has to refuse them as a destination.
            if (src?.startsWith("c:") || dst?.startsWith("c:")) return;
            if (src && dst && canDrop(draft, src, dst, placement)) e.preventDefault();
          }}
          onMove={(e) => {
            const src = keyOf(e.detail.source.element);
            const dst = keyOf(e.detail.destination.element);
            const placement = e.detail.destination.placement as Placement;
            if (src?.startsWith("c:") || dst?.startsWith("c:")) return;
            if (src && dst) update((d) => applyMove(d, src, dst, placement));
          }}
          onItemToggle={(e) => {
            // Controlled: suppress the built-in toggle and drive `expanded` from state, which is
            // keyed by the stable section/group/param key so a collapse survives drag-reordering.
            e.preventDefault();
            const id = (e.detail.item as HTMLElement).dataset.collapse;
            if (id) toggle(id);
          }}
          onItemClick={(e) => {
            const rowKey = keyOf(e.detail.item);
            if (!rowKey) return;
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
              setTitleEdit({ key: rowKey, original: title });
            }
          }}
        >
          {draft.structure.sections.map(sectionItem)}
          {orphanFormulas.map(formulaItem)}
        </Tree>
      )}
      </div>

      {/* One menu for whichever row's add-arrow is open. A section adds a group of either kind; a
          parameter adds a formula or a copy of itself. */}
      {rowMenu && menuRef ? (
        <Menu open opener={openerId(rowMenu)} onClose={() => setRowMenu(null)}
          onItemClick={(e) => {
            const what = (e.detail.item as HTMLElement).dataset.add;
            if (menuRef.kind === "section") {
              if (what === "group") addGroup(menuRef.s);
              else if (what === "calc" || what === "items") addTable(what, menuRef.s);
            } else if (menuRef.kind === "param") {
              if (what === "formula") addFormula(menuRef.key);
              else if (what === "dup") update((d) => duplicateParam(d, menuRef.key));
            }
            setRowMenu(null);
          }}>
          {menuRef.kind === "section" ? (
            <>
              <MenuItem text="Normal group" icon="add" data-add="group" />
              <MenuItem text="Calculation table" icon="table-view" data-add="calc" />
              <MenuItem text="Item grid" icon="product" data-add="items" disabled={hasItems}
                tooltip={hasItems ? "This model already has an item grid" : undefined} />
            </>
          ) : (
            <>
              <MenuItem text="Add formula here" icon="add" data-add="formula" />
              <MenuItem text="Duplicate parameter" icon="copy" data-add="dup" />
            </>
          )}
        </Menu>
      ) : null}

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
          lookupsError={lookupsError} onRetryLookups={onRetryLookups} />
      </SplitterElement>
    </SplitterLayout>
  );
}

// SplitterLayout is a React component, not a web component — no `slot` to forward, unlike
// DynamicSideContent's `sideContent`.
function PreviewPane({ modelId, draft, issues, lookups, lookupsError, onRetryLookups }: {
  modelId: string; draft: ModelDef; issues: Issue[];
  lookups?: ResolvedLookups; lookupsError?: Error | null; onRetryLookups: () => void;
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
      {issues.length > 0 ? (
        <MessageStrip design="Critical" hideCloseButton>
          Showing the last valid version — fix {issues.length} error{issues.length === 1 ? "" : "s"} to preview the current draft.
        </MessageStrip>
      ) : null}
      {lookupsError ? (
        <div style={{ padding: "0 1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <MessageStrip design="Negative" hideCloseButton style={{ flex: 1 }}>{lookupsError.message}</MessageStrip>
          <Button onClick={onRetryLookups}>Retry</Button>
        </div>
      ) : null}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "0 1rem 1rem" }}>
        {lookups && lk && prop ? (
          <ConfiguratorForm model={previewModel} lookups={lookups} lk={lk} prop={prop} entries={entries} onChange={setEntries}
            onQueryPick={(k, t, sel) => setPicks((p) => setQueryPick(p, k, t, sel))}
            querySource={{ kind: "project", modelId }}
            tables={tables} onTablesChange={setTables} />
        ) : lookupsError ? null : <BusyIndicator active delay={0} />}
      </div>
    </div>
  );
}
