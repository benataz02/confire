import { useState, type ReactNode } from "react";
import {
  Bar, Button, CheckBox, Dialog, Input, Option, Select, Tab, TabContainer, Table, TableCell,
  TableHeaderCell, TableHeaderRow, TableRow, TableRowAction,
} from "@ui5/webcomponents-react";
import type { GridState } from "./Grid.tsx";
import type { ListColumn } from "../types.ts";

// GridSettingsDialog (§3.4): the view's columns (visible, order, label), its sort rules and its
// grouping, as a draft that only Confirm writes back. Sort and group offer only columns that allow
// it (`sortable !== false`, `groupable === true`), as in Beas.

export type ColumnItem = { key: string; label: string; visible: boolean; defaultLabel: string; locked?: boolean };

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

/** Movable rows of {visible, label}. `locked` rows cannot be hidden (the object page keeps its
 *  editable and required fields); `fixedLabels` shows the labels without letting them change. */
export function ColumnsTab({ items, onChange, fixedLabels }: {
  items: ColumnItem[];
  onChange: (items: ColumnItem[]) => void;
  fixedLabels?: boolean;
}) {
  return (
    <Table
      headerRow={
        <TableHeaderRow>
          <TableHeaderCell width="6rem"><span>Visible</span></TableHeaderCell>
          <TableHeaderCell><span>{fixedLabels ? "Name" : "Label"}</span></TableHeaderCell>
        </TableHeaderRow>
      }
      onMoveOver={(e) => e.preventDefault()}
      onMove={(e) => {
        const src = (e.detail.source.element as unknown as { rowKey?: string } | null)?.rowKey;
        const dst = (e.detail.destination.element as unknown as { rowKey?: string } | null)?.rowKey;
        if (src && dst) onChange(move(items, src, dst, e.detail.destination.placement === "After"));
      }}
    >
      {items.map((d) => (
        <TableRow key={d.key} rowKey={d.key} movable>
          <TableCell>
            <CheckBox checked={d.visible || !!d.locked} disabled={d.locked} accessibleName={`Show ${d.label}`}
              onChange={() => onChange(items.map((x) => (x.key === d.key ? { ...x, visible: !x.visible } : x)))} />
          </TableCell>
          <TableCell>
            {fixedLabels ? <span>{d.label}</span> : (
              <Input value={d.label} placeholder={d.defaultLabel} style={{ width: "100%" }}
                onInput={(e) => {
                  const v = e.target.value;
                  onChange(items.map((x) => (x.key === d.key ? { ...x, label: v } : x)));
                }} />
            )}
          </TableCell>
        </TableRow>
      ))}
    </Table>
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
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "0.5rem 0" }}>
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
      <div>
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
  const label = (c: ListColumn) => c.label ?? c.key;
  // A snapshot taken when the dialog opened, not a live mirror of the view.
  const [items, setItems] = useState<ColumnItem[]>(() => {
    const shown = state.columns.map((k) => columns.find((c) => c.key === k)).filter((c): c is ListColumn => !!c);
    const hidden = columns.filter((c) => !state.columns.includes(c.key));
    return [...shown, ...hidden].map((c) => ({
      key: c.key, defaultLabel: label(c), label: state.labels?.[c.key] ?? label(c), visible: state.columns.includes(c.key),
    }));
  });
  const [sortBy, setSortBy] = useState(state.sortBy);
  const [groupBy, setGroupBy] = useState(state.groupBy.map((field) => ({ field })));

  const confirm = () => {
    const renamed = Object.fromEntries(items.filter((d) => d.label.trim() && d.label !== d.defaultLabel).map((d) => [d.key, d.label]));
    onConfirm({
      columns: items.filter((d) => d.visible).map((d) => d.key),
      labels: renamed,
      sortBy,
      groupBy: groupBy.map((g) => g.field),
    });
  };

  return (
    <Dialog open onClose={onClose} headerText="View settings" style={{ width: "min(40rem, 95vw)" }}
      footer={
        <Bar design="Footer"
          startContent={<Button design="Transparent" onClick={() => onConfirm({ columnWidths: {} })}>Reset widths</Button>}
          endContent={
            <>
              <Button design="Emphasized" onClick={confirm}>OK</Button>
              <Button design="Transparent" onClick={onClose}>Cancel</Button>
            </>
          } />
      }>
      <TabContainer>
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
