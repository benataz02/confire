import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Bar, Button, Icon, IllustratedMessage, Menu, MenuItem, SegmentedButton, SegmentedButtonItem,
  SplitButton, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableSelectionMulti,
  Tag, Text, Title,
  type SplitButtonDomRef,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/AddColumn.js";
import { isTableGroup, itemsTable } from "@confire/config-engine";
import type { Issue, ModelDef, Param, TableDef } from "@confire/config-engine";
import { confirm } from "@confire/ui/confirm.ts";
import type { ParamSearch } from "./paramRoute.ts";
import { newCalcTable } from "../../features/model/table.ts";
import { localizeItems } from "./starterModel.ts";
import { TitleDialog } from "./TitleDialog.tsx";
import { DuplicateDialog } from "./DuplicateDialog.tsx";
import { FormulaDialog } from "./FormulaDialog.tsx";
import type { TableCols } from "./exprHelpers.ts";
import {
  applyMove, canDrop, copyKeys, deleteNodes, duplicateNodes, isItemsRow, outermost, parseRowKey, placeTable, rowKeyOf,
  tableKeyAt, uniqueKey, type CopyKey, type Placement, type RowRef,
} from "./structureOps.ts";
import { useI18n } from "../../i18n.ts";
import { copy, issueFor, type Translate } from "./builderMessages.ts";

type Tables = TableCols[];
type Update = (fn: (d: ModelDef) => ModelDef) => void;

function paramDetail(p: Param, t: Translate): string {
  const bits: string[] = [p.type, p.ui];
  if (p.domain) bits.push(p.domain.kind === "range" ? t("MODEL_KIND_RANGE")
    : p.domain.ref.source === "manual" ? t("MODEL_SRC_MANUAL")
    : p.domain.ref.source === "query" ? t("MODEL_SRC_QUERY")
    : t("MODEL_BADGE_TABLE"));
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

// Section and group backgrounds: TableRow has no highlight/background prop, and a document-level
// rule is the one thing that beats the shadow root's own `:host`.
if (typeof document !== "undefined" && !document.getElementById("confire-params-rows")) {
  const el = document.createElement("style");
  el.id = "confire-params-rows";
  const R = `.confire-params-struct [ui5-table-row]`;
  el.textContent =
    `${R}[row-key^="s:"]{background:var(--sapList_TableGroupHeaderBackground);` +
    `border-block-end:1px solid var(--sapList_TableGroupHeaderBorderColor)}` +
    `${R}[row-key^="g:"]{background:var(--sapList_Hover_Background)}`;
  document.head.appendChild(el);
}

type AddKind = "section" | "group" | "param" | "formula" | "calc" | "items";
const ADD_LABEL: Record<AddKind, string> = {
  section: "MODEL_SECTION", group: "MODEL_GROUP", param: "MODEL_PARAM",
  formula: "MODEL_FORMULA", calc: "MODEL_CALC_TABLE", items: "MODEL_ITEM_GRID",
};
// Same glyph on the row and on Add, so the kind is recognisable without the word that used to
// lead Details ("section · key"). `group` is three people, so a form group uses the list glyph.
const ADD_ICON: Record<AddKind, string> = {
  section: "folder-blank", group: "list", param: "form",
  formula: "fx", calc: "table-view", items: "product",
};

/** A table is a group in the model; the glyph follows its role (item grid or calculation table). */
function rowKind(ref: RowRef, draft: ModelDef): AddKind {
  if (ref.kind !== "table") return ref.kind;
  const key = tableKeyAt(draft, ref.s, ref.g);
  return (draft.tables ?? []).find((tb) => tb.key === key)?.role === "items" ? "items" : "calc";
}

/** Kind glyph. Image mode keeps the kind in the accessible name: Details no longer spells it. */
function RowIcon({ name, label }: { name: string; label: string }) {
  return <Icon name={name} mode="Image" design="Neutral" accessibleName={label} showTooltip style={{ flex: "0 0 auto" }} />;
}
// The Add button's main action is the last kind picked from its menu, per browser like density.
const ADD_KEY = "modelBuilder.addLast";

// Stable across a drag: a row key is a position, these are the section/group/parameter keys.
const collapseId = {
  section: (key: string) => `S:${key}`,
  group: (section: string, group: string) => `G:${section}/${group}`,
  param: (key: string) => `P:${key}`,
};

function readCollapsed(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** Per model, so a refresh keeps what was collapsed. ponytail: localStorage, same as the Add button's
 *  last kind — a ui_user_state row only if this has to follow the user to another browser. */
function useCollapsed(modelId?: string): [Set<string>, (id: string) => void, (ids: Iterable<string>) => void] {
  const key = `modelBuilder.collapsed.${modelId ?? "new"}`;
  const [state, setState] = useState(() => ({ key, ids: readCollapsed(key) }));
  if (state.key !== key) setState({ key, ids: readCollapsed(key) });
  const ids = state.key === key ? state.ids : readCollapsed(key);
  const write = (next: Iterable<string>) => {
    const stored = new Set(next);
    localStorage.setItem(key, JSON.stringify([...stored]));
    setState({ key, ids: stored });
  };
  const toggle = (id: string) => {
    const n = new Set(ids);
    n.delete(id) || n.add(id);
    write(n);
  };
  return [ids, toggle, write];
}

function useLastAdd(): [AddKind, (kind: AddKind) => void] {
  const [kind, setKind] = useState<AddKind>(() => {
    const saved = localStorage.getItem(ADD_KEY);
    return saved && saved in ADD_LABEL ? (saved as AddKind) : "param";
  });
  return [kind, (next) => { setKind(next); localStorage.setItem(ADD_KEY, next); }];
}

/** The Parameters section (a template): the structure tree. */
export function ParamsTab({ modelId, draft, update, issues, tables }: {
  /** absent while the model itself is still unsaved — the parameter page lives under `/models/new` */
  modelId?: string;
  draft: ModelDef; update: Update; issues: Issue[]; tables: Tables;
}) {
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);
  const navigate = useNavigate({ from: "/$slug" });
  const openParam = (search: ParamSearch) => {
    if (modelId) void navigate({ to: "/$slug/models/$id/parameter", params: { id: modelId }, search });
    else void navigate({ to: "/$slug/models/new/parameter", search });
  };
  const openTable = (key: string) => {
    if (modelId) void navigate({ to: "/$slug/models/$id/table", params: { id: modelId }, search: { key } });
    else void navigate({ to: "/$slug/models/new/table", search: { key } });
  };
  // The formula open in FormulaDialog; no `at` is one not added yet, which only its Save creates.
  const [formula, setFormula] = useState<{ at?: number; initial: ModelDef["computed"][number] } | null>(null);
  // Section/group whose heading is open in TitleDialog, with the values it opens on; no `ref` is a
  // section not added yet, which only its Save creates.
  const [titleEdit, setTitleEdit] = useState<{ ref?: RowRef; initial: string } | null>(null);
  // Ids are section/group/parameter keys, not row positions, so a drag does not retarget them.
  const [collapsed, toggle, setCollapsed] = useCollapsed(modelId);
  // Row keys are positions, so every edit that moves rows clears the selection rather than let it
  // land on whichever rows moved into those places.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dup, setDup] = useState<{ refs: RowRef[]; keys: CopyKey[] } | null>(null);
  const addOpener = useRef<SplitButtonDomRef>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [lastAdd, setLastAdd] = useLastAdd();

  /** `at` is the row's place: where an Add lands when this is the one row picked. */
  type StructRow = {
    kind: "struct"; key: string; depth: number; label: string; detail: string; ref: RowRef;
    at: { s: number; g?: number }; collapseId?: string; param?: Param;
  };
  type Row = StructRow | { kind: "formula"; key: string; idx: number; ref: RowRef };
  const rows: Row[] = [];
  const formulaRow = (i: number): Row => ({ kind: "formula", key: rowKeyOf({ kind: "formula", i }), idx: i, ref: { kind: "formula", i } });
  const defOf = (k: string): TableDef | undefined => (draft.tables ?? []).find((t) => t.key === k);

  // A formula draws under the parameter it is tied to. One tied to none (a model older than the
  // tie) or to a parameter placed nowhere draws under the last placed one, the one row guaranteed
  // to be there to hang it on.
  const placed = draft.structure.sections.flatMap((s) => s.groups.flatMap((g) => (isTableGroup(g) ? [] : g.params)));
  const lastParam = placed.at(-1);
  const drawnUnder = (i: number) => {
    const p = draft.computed[i]?.param;
    return p !== undefined && placed.includes(p) ? p : lastParam;
  };
  const formulas = draft.computed.map((_, i) => i);
  const formulaAnchors = new Set(formulas.flatMap((i) => {
    const k = drawnUnder(i);
    return k ? [k] : [];
  }));
  // Includes levels a collapsed parent hides, so Collapse all stays collapsed once that parent opens.
  const allCollapseIds = draft.structure.sections.flatMap((s) => [
    collapseId.section(s.key),
    ...s.groups.flatMap((g) => (isTableGroup(g) ? [] : [
      collapseId.group(s.key, g.key),
      ...g.params.flatMap((k) => (formulaAnchors.has(k) ? [collapseId.param(k)] : [])),
    ])),
  ]);

  draft.structure.sections.forEach((s, si) => {
    const sId = collapseId.section(s.key);
    rows.push({ kind: "struct", key: rowKeyOf({ kind: "section", s: si }), depth: 0, label: s.title, detail: s.key, ref: { kind: "section", s: si }, at: { s: si }, collapseId: sId });
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
          detail: def ? cols : t("MODEL_MISSING_TABLE"),
          ref: { kind: "table", s: si, g: gi }, at: { s: si },
        });
        return;
      }
      const gId = collapseId.group(s.key, g.key);
      rows.push({ kind: "struct", key: rowKeyOf({ kind: "group", s: si, g: gi }), depth: 1, label: g.title, detail: g.key, ref: { kind: "group", s: si, g: gi }, at: { s: si, g: gi }, collapseId: gId });
      if (collapsed.has(gId)) return;
      g.params.forEach((k) => {
        const p = draft.parameters.find((x) => x.key === k);
        const own = formulas.filter((i) => drawnUnder(i) === k);
        const pId = collapseId.param(k);
        rows.push({
          kind: "struct", key: rowKeyOf({ kind: "param", key: k }), depth: 2, label: p?.label || k,
          detail: p ? paramDetail(p, t) : t("MODEL_MISSING_PARAM"),
          ref: { kind: "param", key: k }, at: { s: si, g: gi }, param: p,
          // Only a parameter that anchors formulas has anything to collapse.
          collapseId: own.length ? pId : undefined,
        });
        if (collapsed.has(pId)) return;
        for (const i of own) rows.push(formulaRow(i));
      });
    });
  });
  // Only reachable with no parameter placed anywhere — there is no row to hang them under.
  if (!lastParam) for (const i of formulas) rows.push(formulaRow(i));

  // Only what is on screen counts: a row hidden by a collapse, or a key outliving its row, is
  // never deleted or copied unseen.
  const picked = rows.filter((r) => selected.has(r.key));
  const acted = outermost(draft, picked.map((r) => r.ref)).filter((r) => !isItemsRow(draft, r));

  // Confirm only when a delete is destructive: a section/group with children (cascades), a
  // parameter or table (drops its whole definition), or several rows at once. Empty sections and
  // groups, and formulas, delete without a prompt.
  const confirmDelete = async (refs: RowRef[]) => {
    if (refs.length > 1) return confirm({ title: t("MODEL_DELETE"), message: t("MODEL_DELETE_SELECTED_MSG", String(refs.length)), actionText: t("MODEL_DELETE"), destructive: true });
    const ref = refs[0]!;
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
    } else if (ref.kind === "param") {
      const p = draft.parameters.find((x) => x.key === ref.key);
      message = t("MODEL_DELETE_PARAM_MSG", p?.label || ref.key);
    }
    return message === null || confirm({ title: t("MODEL_DELETE"), message, actionText: t("MODEL_DELETE"), destructive: true });
  };
  const removeSelected = async () => {
    const refs = acted;
    if (!refs.length || !await confirmDelete(refs)) return;
    setSelected(new Set());
    update((d) => deleteNodes(d, refs));
  };
  const duplicateSelected = (keys: CopyKey[]) => {
    const refs = dup!.refs;
    setDup(null);
    setSelected(new Set());
    update((d) => duplicateNodes(d, refs, keys));
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

  // A new section comes with a group of the same name, so a parameter has somewhere to go at once.
  const addSection = (name: string) => {
    const title = name.trim() || copy(t, "MODEL_NEW_SECTION", "New section");
    update((d) => ({
      ...d,
      structure: {
        sections: [...d.structure.sections, {
          key: uniqueKey("section", d.structure.sections.map((s) => s.key)), title,
          groups: [{ key: "group", title, params: [] }],
        }],
      },
    }));
  };
  const addGroup = (s: number) => update((d) => ({
    ...d,
    structure: {
      sections: d.structure.sections.map((sec, i) => i !== s ? sec : {
        ...sec,
        groups: [...sec.groups, {
          key: uniqueKey("group", sec.groups.flatMap((g) => (isTableGroup(g) ? [] : [g.key]))),
          title: copy(t, "MODEL_NEW_GROUP", "New group"), params: [],
        }],
      }),
    },
  }));
  const addFormula = (param: string) => setFormula({
    initial: { key: uniqueKey("value", [...draft.parameters.map((p) => p.key), ...draft.computed.map((c) => c.key)]), expr: "", param },
  });
  const saveFormula = (at: number | undefined, f: ModelDef["computed"][number]) => update((d) => ({
    ...d, computed: at === undefined ? [...d.computed, f] : d.computed.map((x, j) => (j === at ? f : x)),
  }));
  // A table is a group, so it is added to a section, not into one.
  const addTable = (role: "calc" | "items", s: number) => update((d) => {
    const table = role === "items" ? localizeItems(itemsTable(), t) : newCalcTable((d.tables ?? []).map((x) => x.key), t);
    return placeTable({ ...d, tables: [...(d.tables ?? []), table] }, table.key, s);
  });
  // checkModel allows at most one items table, and requires exactly one.
  const hasItems = (draft.tables ?? []).some((t) => t.role === "items");

  // An Add always lands at the bottom: of the one picked row's section or group, else of the last
  // one. A section is top-level, so it only ever appends. A formula goes under the picked parameter
  // (or beside the picked formula), else under the last parameter of where a parameter would land.
  const one = picked.length === 1 && picked[0]!.kind === "struct" ? picked[0]!.at : undefined;
  const sections = draft.structure.sections;
  const fieldGroups = (s: number) => sections[s]?.groups.flatMap((g, gi) => (isTableGroup(g) ? [] : [gi])) ?? [];
  const lastIn = (s: number, g?: number) =>
    sections[s]?.groups.flatMap((x, gi) => (isTableGroup(x) || (g !== undefined && gi !== g) ? [] : x.params)).at(-1);
  const pickedRow = picked.length === 1 ? picked[0]! : undefined;
  const formulaParam = pickedRow?.ref.kind === "param" ? pickedRow.ref.key
    : pickedRow?.kind === "formula" ? drawnUnder(pickedRow.idx)
    : one ? lastIn(one.s, one.g) : lastParam;
  const intoS = one ? one.s : sections.length - 1;
  const intoG = one?.g !== undefined ? { s: one.s, g: one.g }
    : [...(one ? [one.s] : sections.map((_, si) => si))].reverse()
      .map((s) => ({ s, g: fieldGroups(s).at(-1) }))
      .find((x): x is { s: number; g: number } => x.g !== undefined);
  const addable: Record<AddKind, boolean> = {
    section: true, group: intoS >= 0, param: !!intoG, formula: !!formulaParam, calc: intoS >= 0, items: intoS >= 0 && !hasItems,
  };
  const add = (what: AddKind) => {
    if (!addable[what]) return;
    if (what === "section") setTitleEdit({ initial: "" });
    else if (what === "formula") addFormula(formulaParam!);
    else if (what === "param") openParam(intoG!);
    else if (what === "group") addGroup(intoS);
    else addTable(what, intoS);
  };

  return (
    // Form's shell (.ui5-form-root) is the rounded card: 0.75rem and the group background. Table
    // exposes no CSS part for its frame, so the title bar and the rows share this card and overflow
    // clips them to the curve. flex:1 + minHeight:0 is fitContent's contract (see the params
    // section): the card fills the page's height and the Table the rest of it. A Scroll-mode Table
    // scrolls its own rows (`#table` is `height: 100%`) once its height is definite, which is what
    // keeps the toolbar and the sticky header in place; a 0 basis is that definite height, an
    // `auto` one is sized to the rows. The section already pads the top and the start.
    // The dialogs sit inside: they are top-layer popups, which the clip does not reach.
    <div style={{
      display: "flex", flexDirection: "column", flex: "1 1 0", minInlineSize: 0, minHeight: 0,
      margin: "0 1rem 1rem 0",
      backgroundColor: "var(--sapGroup_ContentBackground)",
      borderRadius: "0.75rem", overflow: "hidden",
    }}>
      {/* The table's toolbar: Add lands at the bottom (see `add`); Duplicate and Delete act on the
          selection. marginTop cancels the Subheader's -1px overlap, which the clip would shave. */}
      <Bar design="Subheader" style={{ borderBlockEnd: "none", marginTop: 0 }}
        startContent={<Title level="H5">{t("MODEL_FORM_STRUCTURE")}</Title>}
        endContent={
          <>
            {/* Where the remembered kind cannot land (no section yet, a second item grid), the main
                action opens the menu instead of doing nothing. */}
            <SplitButton ref={addOpener} design="Transparent"
              accessibilityAttributes={{ arrowButton: { hasPopup: "menu", expanded: addOpen } }}
              onClick={() => (addable[lastAdd] ? add(lastAdd) : setAddOpen(true))}
              onArrowClick={() => setAddOpen(true)}>
              {t("MODEL_ADD_WHAT", t(ADD_LABEL[lastAdd]))}
            </SplitButton>
            <Button design="Transparent" disabled={!acted.length}
              onClick={() => setDup({ refs: acted, keys: copyKeys(draft, acted) })}>
              {t("MODEL_DUPLICATE")}
            </Button>
            <Button design="Transparent" disabled={!acted.length} onClick={() => void removeSelected()}>
              {t("MODEL_DELETE")}
            </Button>
            {/* Multiple, and the press is cleared here: Single would leave one item pressed, and React
                will not write selected={false} again when that prop never changed. */}
            <SegmentedButton accessibleName={t("MODEL_EXPAND_COLLAPSE")} selectionMode="Multiple" itemsFitContent
              onSelectionChange={(e) => {
                const act = (e.detail.selectedItems[0] as HTMLElement | undefined)?.dataset.act;
                for (const el of e.target.querySelectorAll("ui5-segmented-button-item"))
                  (el as HTMLElement & { selected: boolean }).selected = false;
                if (act === "expand") setCollapsed([]);
                else if (act === "collapse") setCollapsed(allCollapseIds);
              }}>
              <SegmentedButtonItem icon="expand-all" tooltip={t("MODEL_EXPAND_ALL")} accessibleName={t("MODEL_EXPAND_ALL")}
                data-act="expand" selected={false} disabled={!allCollapseIds.length} />
              <SegmentedButtonItem icon="collapse-all" tooltip={t("MODEL_COLLAPSE_ALL")} accessibleName={t("MODEL_COLLAPSE_ALL")}
                data-act="collapse" selected={false} disabled={!allCollapseIds.length} />
            </SegmentedButton>
          </>
        }
      />
      {addOpen ? (
        <Menu open opener={addOpener.current} onClose={() => setAddOpen(false)}
          onItemClick={(e) => {
            const kind = (e.detail.item as HTMLElement).dataset.add as AddKind;
            setLastAdd(kind);
            add(kind);
          }}>
          {(Object.keys(ADD_LABEL) as AddKind[]).map((kind) => (
            <MenuItem key={kind} data-add={kind} text={t(ADD_LABEL[kind])} icon={ADD_ICON[kind]} disabled={!addable[kind]} />
          ))}
        </Menu>
      ) : null}

      <Table
        accessibleName={t("MODEL_FORM_STRUCTURE")}
        className="confire-params-struct"
        style={{ flex: "1 1 0", minHeight: 0 }}
        noData={
          <IllustratedMessage name="AddColumn" design="Dot" titleText={t("MODEL_NO_STRUCTURE")}
            subtitleText={t("MODEL_NO_STRUCTURE_SUB")} />
        }
        features={
          <TableSelectionMulti selected={[...selected].join(" ")}
            onChange={(e) => setSelected(e.target.getSelectedAsSet())} />
        }
        onMoveOver={(e) => {
          const src = (e.detail.source.element as HTMLElement | null)?.getAttribute("row-key");
          const dst = (e.detail.destination.element as HTMLElement | null)?.getAttribute("row-key");
          const placement = e.detail.destination.placement as Placement;
          if (src && dst && canDrop(draft, src, dst, placement)) e.preventDefault();
        }}
        onMove={(e) => {
          const src = (e.detail.source.element as HTMLElement | null)?.getAttribute("row-key");
          const dst = (e.detail.destination.element as HTMLElement | null)?.getAttribute("row-key");
          const placement = e.detail.destination.placement as Placement;
          if (!src || !dst) return;
          setSelected(new Set());
          update((d) => applyMove(d, src, dst, placement));
        }}
        onRowClick={(e) => {
          const ref = parseRowKey(((e.detail.row as unknown) as HTMLElement).getAttribute("row-key")!);
          if (ref.kind === "formula") return setFormula({ at: ref.i, initial: draft.computed[ref.i]! });
          if (ref.kind === "table") {
            const key = tableKeyAt(draft, ref.s, ref.g);
            if (key) openTable(key);
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
          <TableHeaderRow sticky>
            <TableHeaderCell width="45%"><span>{t("MODEL_STRUCTURE")}</span></TableHeaderCell>
            <TableHeaderCell width="8rem"><span>{t("MODEL_MANDATORY")}</span></TableHeaderCell>
            <TableHeaderCell width="8rem"><span>{t("MODEL_COL_EXCLUDE")}</span></TableHeaderCell>
            <TableHeaderCell><span>{t("MODEL_DETAILS")}</span></TableHeaderCell>
          </TableHeaderRow>
        }
      >
        {rows.map((r) =>
          r.kind === "formula" ? (
            // Read-only like every row: a click opens FormulaDialog.
            <TableRow key={r.key} rowKey={r.key} movable interactive>
              <TableCell>
                <Gutter depth={3}>
                  <RowIcon name={ADD_ICON.formula} label={t("MODEL_FORMULA")} />
                  <Text>{draft.computed[r.idx]!.key}</Text>
                </Gutter>
              </TableCell>
              <TableCell />
              <TableCell />
              <TableCell>
                <Text style={{ color: issueFor(issues, `computed[${r.idx}].expr`) ? "var(--sapNegativeColor)" : undefined }}>
                  {`= ${draft.computed[r.idx]!.expr}`}
                </Text>
              </TableCell>
            </TableRow>
          ) : (
            <TableRow key={r.key} rowKey={r.key} movable interactive>
              <TableCell>
                <Gutter depth={r.depth} collapse={r.collapseId
                  ? { collapsed: collapsed.has(r.collapseId), onToggle: () => toggle(r.collapseId!) }
                  : undefined}>
                  <RowIcon name={ADD_ICON[rowKind(r.ref, draft)]} label={t(ADD_LABEL[rowKind(r.ref, draft)])} />
                  <Text style={{ fontWeight: r.depth === 0 ? "bold" : "normal" }}>{r.label}</Text>
                </Gutter>
              </TableCell>
              <TableCell>
                {r.param?.mandatory ? <Tag design="Information" hideStateIcon>{t("MODEL_MANDATORY")}</Tag> : null}
              </TableCell>
              <TableCell>
                {r.param?.excludeFromDomains ? <Tag design="Neutral" hideStateIcon>{t("MODEL_EXCLUDED")}</Tag> : null}
              </TableCell>
              <TableCell><Text>{r.detail}</Text></TableCell>
            </TableRow>
          ),
        )}
      </Table>

      {titleEdit ? (
        <TitleDialog initial={titleEdit.initial} section={titleEdit.ref?.kind !== "group"}
          onCancel={() => setTitleEdit(null)}
          onOk={(v) => {
            if (titleEdit.ref) saveTitle(titleEdit.ref, v);
            else addSection(v);
            setTitleEdit(null);
          }} />
      ) : null}
      {formula ? (
        <FormulaDialog draft={draft} tables={tables} at={formula.at} initial={formula.initial}
          onCancel={() => setFormula(null)}
          onOk={(f) => { saveFormula(formula.at, f); setFormula(null); }} />
      ) : null}
      {dup ? <DuplicateDialog draft={draft} keys={dup.keys} onCancel={() => setDup(null)} onOk={duplicateSelected} /> : null}
    </div>
  );
}
