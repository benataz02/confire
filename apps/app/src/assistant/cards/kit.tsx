import { useState, type ReactNode } from "react";
import {
  Card, CardHeader, Label, Link, List, ListItemStandard, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Text,
} from "@ui5/webcomponents-react";
import type { ValueState } from "@confire/ui/types.ts";

// Joule's in-chat card shapes over UI5 (plan "The look"), and nothing app-specific: an object card,
// a list card that grows by three, a table card. A card draws what it is given; the registry turns a
// tool's output into it.

const FACTS = { display: "grid", gridTemplateColumns: "minmax(6rem, max-content) 1fr", gap: "0.25rem 1rem", padding: "0 1rem 0.75rem", alignItems: "baseline" } as const;
const FOOTER = { display: "flex", flexWrap: "wrap", gap: "0.5rem", padding: "0.5rem 1rem 0.75rem" } as const;

export function ObjectCard({ title, subtitle, status, onOpen, facts, actions, children }: {
  title: string;
  subtitle?: string;
  status?: { text: string; state: ValueState };
  onOpen?: () => void;
  facts?: { label: string; value: ReactNode }[];
  /** at most three, Joule's object card */
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card header={<CardHeader titleText={title} subtitleText={subtitle} additionalText={status?.text}
      interactive={!!onOpen} onClick={onOpen} />}>
      {children}
      {facts?.length ? (
        <div style={FACTS}>
          {facts.map((f) => [<Label key={`${f.label}l`}>{f.label}</Label>, <div key={`${f.label}v`}>{f.value}</div>])}
        </div>
      ) : null}
      {actions ? <div style={FOOTER}>{actions}</div> : null}
    </Card>
  );
}

export type CardItem = {
  id: string; title: string; description?: string; info?: string; infoState?: ValueState; icon?: string; onOpen?: () => void;
};

const STEP = 3;

/** Three rows, three more per "Show more", up to the twenty a tool answers. `total` past the rows
 *  offers the whole list. */
export function ListCard({ title, subtitle, items, total, openAll, openAllText, noData, moreText, children }: {
  title: string;
  subtitle?: string;
  items: CardItem[];
  total?: number;
  openAll?: () => void;
  openAllText?: string;
  noData: string;
  moreText?: string;
  /** under the list, before "Open all" */
  children?: ReactNode;
}) {
  const [shown, setShown] = useState(STEP);
  const visible = items.slice(0, shown);
  return (
    <Card header={<CardHeader titleText={title} subtitleText={subtitle} />}>
      <List noDataText={noData} growing={shown < items.length ? "Button" : "None"} growingButtonText={moreText}
        separators="Inner"
        onLoadMore={() => setShown((n) => Math.min(n + STEP, items.length))}
        onItemClick={(e) => items.find((x) => x.id === (e.detail.item as HTMLElement).dataset.id)?.onOpen?.()}>
        {visible.map((x) => (
          <ListItemStandard key={x.id} data-id={x.id} description={x.description} additionalText={x.info}
            additionalTextState={x.infoState} icon={x.icon} type={x.onOpen ? "Navigation" : "Inactive"}
            wrappingType="Normal">
            {x.title}
          </ListItemStandard>
        ))}
      </List>
      {children}
      {openAll && total !== undefined && total > items.length ? (
        <div style={FOOTER}><Link onClick={openAll}>{openAllText}</Link></div>
      ) : null}
    </Card>
  );
}

export function TableCard({ title, subtitle, columns, rows, footer, label }: {
  title: string;
  subtitle?: string;
  columns: { key: string; label: string; end?: boolean }[];
  rows: { id: string; cells: Record<string, ReactNode>; onOpen?: () => void }[];
  footer?: ReactNode;
  label?: string;
}) {
  return (
    <Card header={<CardHeader titleText={title} subtitleText={subtitle} />}>
      <Table overflowMode="Popin" accessibleName={label ?? title}
        onRowClick={(e) => rows.find((r) => r.id === (e.detail.row as unknown as { rowKey: string }).rowKey)?.onOpen?.()}
        headerRow={
          <TableHeaderRow>
            {columns.map((c) => <TableHeaderCell key={c.key} horizontalAlign={c.end ? "End" : undefined}>{c.label}</TableHeaderCell>)}
          </TableHeaderRow>
        }>
        {rows.map((r) => (
          <TableRow key={r.id} rowKey={r.id} interactive={!!r.onOpen}>
            {columns.map((c) => (
              <TableCell key={c.key} horizontalAlign={c.end ? "End" : undefined}>
                {typeof r.cells[c.key] === "string" || typeof r.cells[c.key] === "number" ? <Text>{r.cells[c.key]}</Text> : r.cells[c.key]}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </Table>
      {footer ? <div style={FOOTER}>{footer}</div> : null}
    </Card>
  );
}
