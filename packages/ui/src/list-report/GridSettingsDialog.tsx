import { useState, type ReactNode } from "react";
import {
  Bar, Button, Dialog, Icon, Input, Option, Select, Tab, TabContainer, Table, TableCell, TableHeaderCell,
  TableHeaderRow, TableRow, TableRowAction, TableSelectionMulti, ToggleButton,
} from "@ui5/webcomponents-react";
import type { GridState } from "./Grid.tsx";
import { sameState } from "../views.ts";
import type { ListColumn } from "../types.ts";

// GridSettingsDialog (§3.4): the view's columns (visible, order), its sort rules and its grouping,
// as a draft that only Confirm writes back. Sort and group offer only columns that allow it
// (`sortable !== false`, `groupable === true`), as in Beas.

export type ColumnItem = { key: string; label: string; visible: boolean; locked?: boolean };

const move = <T extends { key: string }>(list: T[], src: string, dst: string, after: boolean): T[] => {
  const next = [...list];
  const from = next.findIndex((d) => d.key === src);
  if (from < 0 || src === dst) return list;
  const [moved] = next.splice(from, 1);
  let to = next.findIndex((d) => d.key === dst);
  if (to < 0) return list;
  if (after) to += 1;
  next.splice(to, 0, moved!);
  return next;
};

const rowKeyOf = (el: unknown) => (el as { rowKey?: string } | null)?.rowKey;

/** The p13n selection panel: selected rows are the visible ones, the move buttons act on the last
 *  clicked row, drag works too. `locked` rows cannot be hidden (the object page keeps its editable
 *  and required fields). `selected` is a space-separated key list, so a key must hold no space —
 *  field names and section ids don't. */
export function ColumnsTab({ items, onChange }: {
  items: ColumnItem[];
  onChange: (items: ColumnItem[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);
  const [active, setActive] = useState<string>();
  const shows = (d: ColumnItem) => d.visible || !!d.locked;
  const q = search.trim().toLowerCase();
  const shown = items.filter((d) => (!onlySelected || shows(d)) && (!q || d.label.toLowerCase().includes(q)));
  const at = shown.findIndex((d) => d.key === active);
  const last = shown.length - 1;
  // Past the neighbour on screen, not in the full list: under a search, every press visibly moves.
  const moveTo = (dst: ColumnItem | undefined, after: boolean) => {
    if (active && dst) onChange(move(items, active, dst.key, after));
  };
  const selected = items.filter(shows);

  return (
    // The toolbar stays put; the table takes the rest of the dialog and scrolls under its header.
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Bar
        startContent={
          <Input value={search} placeholder="Search" showClearIcon icon={<Icon name="search" />}
            accessibleName="Search columns" style={{ width: "16rem" }}
            onInput={(e) => setSearch(e.target.value)} />
        }
        endContent={
          <>
            {/* The label names what a press will show, as in the Fiori p13n selection panel. A fixed
                width so the toolbar does not shift: "Show selected" measures 90px in 72 at 14px,
                ~110px with the cozy padding. */}
            <ToggleButton pressed={onlySelected} onClick={() => setOnlySelected((v) => !v)} style={{ width: "7.5rem" }}>
              {onlySelected ? "Show all" : "Show selected"}
            </ToggleButton>
            <Button icon="collapse-group" design="Transparent" tooltip="Move to top" accessibleName="Move to top"
              disabled={at <= 0} onClick={() => moveTo(shown[0], false)} />
            <Button icon="navigation-up-arrow" design="Transparent" tooltip="Move up" accessibleName="Move up"
              disabled={at <= 0} onClick={() => moveTo(shown[at - 1], false)} />
            <Button icon="navigation-down-arrow" design="Transparent" tooltip="Move down" accessibleName="Move down"
              disabled={at < 0 || at === last} onClick={() => moveTo(shown[at + 1], true)} />
            <Button icon="expand-group" design="Transparent" tooltip="Move to bottom" accessibleName="Move to bottom"
              disabled={at < 0 || at === last} onClick={() => moveTo(shown[last], true)} />
          </>
        } />
      <Table style={{ flex: 1, minHeight: 0 }} noDataText="No columns."
        features={
          <TableSelectionMulti selected={selected.map((d) => d.key).join(" ")}
            onChange={(e) => {
              const set = e.target.getSelectedAsSet();
              // An unticked locked row goes straight back: the element keeps its own selection, and a
              // re-render with an unchanged `selected` would leave it unticked.
              items.forEach((d) => { if (d.locked) set.add(d.key); });
              e.target.setSelectedAsSet(set);
              onChange(items.map((x) => ({ ...x, visible: x.locked ? x.visible : set.has(x.key) })));
            }} />
        }
        headerRow={
          <TableHeaderRow sticky>
            <TableHeaderCell><span style={{ fontWeight: "bold" }}>Select all ({selected.length}/{items.length})</span></TableHeaderCell>
          </TableHeaderRow>
        }
        onRowClick={(e) => setActive(rowKeyOf(e.detail.row))}
        onMoveOver={(e) => e.preventDefault()}
        onMove={(e) => {
          const src = rowKeyOf(e.detail.source.element);
          const dst = rowKeyOf(e.detail.destination.element);
          if (src && dst) onChange(move(items, src, dst, e.detail.destination.placement === "After"));
        }}
      >
        {shown.map((d) => (
          <TableRow key={d.key} rowKey={d.key} movable interactive navigated={d.key === active}>
            <TableCell><span>{d.label}</span></TableCell>
          </TableRow>
        ))}
      </Table>
    </div>
  );
}

/** A list of field picks (sort rules, group levels) with add/remove. */
function RulesTab<R extends { field: string }>({ rules, fields, render, add, onChange, addText }: {
  rules: R[];
  fields: ListColumn[];
  render: (rule: R, set: (r: R) => void) => ReactNode;
  add: (field: string) => R;
  onChange: (rules: R[]) => void;
  addText: string;
}) {
  const free = fields.filter((f) => !rules.some((r) => r.field === f.key));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", paddingBottom: "0.5rem" }}>
      <Table rowActionCount={1} noDataText="None."
        onRowActionClick={(e) => {
          const i = Number((e.detail.row as unknown as HTMLElement).dataset.idx);
          onChange(rules.filter((_, j) => j !== i));
        }}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell><span>Field</span></TableHeaderCell>
            <TableHeaderCell><span /></TableHeaderCell>
          </TableHeaderRow>
        }>
        {rules.map((r, i) => (
          <TableRow key={r.field} rowKey={r.field} data-idx={String(i)} actions={<TableRowAction icon="delete" text="Remove" />}>
            <TableCell>
              <Select style={{ width: "100%" }} value={r.field}
                onChange={(e) => onChange(rules.map((x, j) => (j === i ? { ...x, field: e.detail.selectedOption.value ?? x.field } : x)))}>
                {[fields.find((f) => f.key === r.field), ...free].filter((f): f is ListColumn => !!f).map((f) => (
                  <Option key={f.key} value={f.key}>{f.label ?? f.key}</Option>
                ))}
              </Select>
            </TableCell>
            <TableCell>{render(r, (next) => onChange(rules.map((x, j) => (j === i ? next : x))))}</TableCell>
          </TableRow>
        ))}
      </Table>
      <div style={{ paddingInline: "0.5rem" }}>
        <Button icon="add" disabled={!free.length} onClick={() => onChange([...rules, add(free[0]!.key)])}>{addText}</Button>
      </div>
    </div>
  );
}

export function GridSettingsDialog({ columns, state, onConfirm, onClose }: {
  columns: ListColumn[];
  state: GridState;
  onConfirm: (patch: Partial<GridState>) => void;
  onClose: () => void;
}) {
  const toItems = (visible: string[]): ColumnItem[] => {
    const shown = visible.map((k) => columns.find((c) => c.key === k)).filter((c): c is ListColumn => !!c);
    const hidden = columns.filter((c) => !visible.includes(c.key));
    return [...shown, ...hidden].map((c) => ({
      key: c.key, label: c.label ?? c.key, visible: visible.includes(c.key),
    }));
  };
  // A snapshot taken when the dialog opened, not a live mirror of the view.
  const [items, setItems] = useState(() => toItems(state.columns));
  const [sortBy, setSortBy] = useState(state.sortBy);
  const [groupBy, setGroupBy] = useState(state.groupBy.map((field) => ({ field })));

  const visibleKeys = items.filter((d) => d.visible).map((d) => d.key);
  // The declared defaults (`defaultState`), restored into the draft: OK still has to write them.
  const defaults = columns.filter((c) => !c.hidden).map((c) => c.key);
  const atDefault = sameState(visibleKeys, defaults) && !sortBy.length && !groupBy.length;
  const restore = () => { setItems(toItems(defaults)); setSortBy([]); setGroupBy([]); };

  const confirm = () => onConfirm({ columns: visibleKeys, sortBy, groupBy: groupBy.map((g) => g.field) });

  return (
    // A fixed size, so filtering the list or switching tabs does not make the dialog jump.
    <Dialog open onClose={onClose} headerText="View settings" resizable className="confire-flush"
      style={{ width: "min(56rem, 95vw)", height: "min(40rem, 85vh)" }}
      footer={
        <Bar design="Footer"
          endContent={
            <>
              <Button design="Emphasized" onClick={confirm}>OK</Button>
              <Button design="Transparent" onClick={onClose}>Cancel</Button>
              <Button design="Transparent" disabled={atDefault} onClick={restore}>Restore</Button>
            </>
          } />
      }>
      <TabContainer className="confire-flush" style={{ height: "100%" }}>
        <Tab text="Columns" selected>
          <ColumnsTab items={items} onChange={setItems} />
        </Tab>
        <Tab text="Sort">
          <RulesTab rules={sortBy} fields={columns.filter((c) => c.sortable !== false && c.type !== "collection")}
            add={(field) => ({ field, direction: "asc" as const })} onChange={setSortBy} addText="Add sort"
            render={(r, set) => (
              <Select style={{ width: "100%" }} value={r.direction}
                onChange={(e) => set({ ...r, direction: e.detail.selectedOption.value === "desc" ? "desc" : "asc" })}>
                <Option value="asc">Ascending</Option>
                <Option value="desc">Descending</Option>
              </Select>
            )} />
        </Tab>
        <Tab text="Group">
          <RulesTab rules={groupBy} fields={columns.filter((c) => c.groupable === true)}
            add={(field) => ({ field })} onChange={setGroupBy} addText="Add group" render={() => null} />
        </Tab>
      </TabContainer>
    </Dialog>
  );
}
