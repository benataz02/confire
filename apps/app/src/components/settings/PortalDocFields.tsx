import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, BusyIndicator, Button, Card, CardHeader, Dialog, FlexBox, Link, MessageStrip, Table, TableCell, TableHeaderCell,
  TableHeaderRow, TableRow, Text,
} from "@ui5/webcomponents-react";
import { ColumnsTab, type ColumnItem } from "@confire/ui/list-report/GridSettingsDialog.tsx";
import { sameState } from "@confire/ui/views.ts";
import { toast } from "@confire/ui/toast.ts";
import { useI18n } from "../../i18n.ts";
import { client, orpc } from "../../orpc.ts";

// Settings → Portal → Document fields (spec §13.1, D19): which SAP fields clients see on their
// quotations, orders, deliveries and invoices. The options are the server's `pickable` list — the
// denylist is already applied — so this page cannot offer what save would refuse. An entity with
// no entry shows the code defaults; Reset removes the entry.

type Get = Awaited<ReturnType<typeof client.portalSettings.get>>;
type Entity = keyof Get["options"];
type Part = "header" | "lines";
type DocFields = Partial<Record<Entity, { header: string[]; lines: string[] }>>;

const ENTITY_KEY: Record<Entity, string> = {
  Quotations: "NAV_QUOTATIONS",
  Orders: "NAV_ORDERS",
  DeliveryNotes: "NAV_DELIVERIES",
  Invoices: "ADMIN_INVOICES",
};
const PART_KEY: Record<Part, string> = { header: "ADMIN_PART_HEADER", lines: "ADMIN_PART_LINES" };

export function PortalDocFields() {
  const i18n = useI18n();
  const settings = useQuery(orpc.portalSettings.get.queryOptions());
  return (
    <Card header={<CardHeader titleText={i18n.getText("ADMIN_DOC_FIELDS")} subtitleText={i18n.getText("ADMIN_DOC_FIELDS_SUB")} />}>
      {settings.data ? <DocFieldsForm current={settings.data} />
        : settings.error ? <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{settings.error.message}</MessageStrip>
        : <BusyIndicator active style={{ margin: "1rem" }} />}
    </Card>
  );
}

function DocFieldsForm({ current }: { current: Get }) {
  const i18n = useI18n();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<DocFields>(current.docFields as DocFields);
  const [editing, setEditing] = useState<{ entity: Entity; label: string; part: Part } | null>(null);
  // A refetch after save re-seeds the draft from what the server now holds.
  useEffect(() => setDraft(current.docFields as DocFields), [current.docFields]);

  const save = useMutation(orpc.portalSettings.save.mutationOptions({
    onSuccess: () => {
      toast(i18n.getText("ADMIN_PORTAL_SAVED"));
      void qc.invalidateQueries({ queryKey: orpc.portalSettings.get.key() });
    },
  }));

  const listOf = (entity: Entity) => draft[entity] ?? current.defaults;
  const setPart = (entity: Entity, part: Part, keys: string[]) =>
    setDraft((d) => ({ ...d, [entity]: { ...(d[entity] ?? current.defaults), [part]: keys } }));
  const reset = (entity: Entity) => setDraft(({ [entity]: _, ...rest }) => rest as DocFields);
  const dirty = !sameState(draft, current.docFields);

  const count = (entity: Entity, part: Part) => (draft[entity] ? String(draft[entity]![part].length) : i18n.getText("ADMIN_DEFAULT"));
  const entities = (Object.keys(ENTITY_KEY) as Entity[]).map((entity) => ({ entity, label: i18n.getText(ENTITY_KEY[entity]!) }));

  return (
    <FlexBox direction="Column" style={{ padding: "1rem", gap: "1rem" }}>
      {save.error ? <MessageStrip design="Negative" hideCloseButton>{save.error.message}</MessageStrip> : null}
      <Table accessibleName={i18n.getText("ADMIN_DOC_FIELDS")} headerRow={
        <TableHeaderRow>
          <TableHeaderCell>{i18n.getText("ADMIN_COL_DOCUMENT")}</TableHeaderCell>
          <TableHeaderCell>{i18n.getText("ADMIN_COL_HEADER_FIELDS")}</TableHeaderCell>
          <TableHeaderCell>{i18n.getText("ADMIN_COL_LINE_FIELDS")}</TableHeaderCell>
          <TableHeaderCell width="6rem"><span /></TableHeaderCell>
        </TableHeaderRow>
      }>
        {entities.map(({ entity, label }) => (
          <TableRow key={entity} rowKey={entity}>
            <TableCell><Text>{label}</Text></TableCell>
            {(["header", "lines"] as const).map((part) => (
              <TableCell key={part}>
                <Text>{count(entity, part)}</Text>
                <Link style={{ marginInlineStart: "0.5rem" }} onClick={() => setEditing({ entity, label, part })}>{i18n.getText("ADMIN_EDIT")}</Link>
              </TableCell>
            ))}
            <TableCell>{draft[entity] ? <Link onClick={() => reset(entity)}>{i18n.getText("ADMIN_RESET")}</Link> : null}</TableCell>
          </TableRow>
        ))}
      </Table>
      <Text style={{ color: "var(--sapContent_LabelColor)" }}>
        {i18n.getText("ADMIN_DOC_FIELDS_NOTE")}
      </Text>
      <Button design="Emphasized" style={{ alignSelf: "start" }} disabled={!dirty || save.isPending}
        onClick={() => save.mutate({ docFields: draft })}>
        {save.isPending ? i18n.getText("ADMIN_SAVING") : i18n.getText("ADMIN_SAVE")}
      </Button>
      {editing ? (
        <FieldPicker
          title={`${editing.label}: ${i18n.getText(PART_KEY[editing.part])}`}
          selected={listOf(editing.entity)[editing.part]}
          options={current.options[editing.entity][editing.part]}
          onConfirm={(keys) => { setPart(editing.entity, editing.part, keys); setEditing(null); }}
          onClose={() => setEditing(null)} />
      ) : null}
    </FlexBox>
  );
}

/** The grids' own p13n panel (search, tick, reorder): the picked fields first, in order, then the
 *  rest in SAP's order. A picked key the options no longer offer (a UDF since removed) is dropped. */
export function FieldPicker({ title, selected, options, onConfirm, onClose }: {
  // labels in `title` and `options` are already translated by the caller, except SAP field names.
  title: string;
  selected: string[];
  options: { key: string; label: string }[];
  onConfirm: (keys: string[]) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<ColumnItem[]>(() => {
    const byKey = new Map(options.map((o) => [o.key, o]));
    const picked = selected.flatMap((k) => (byKey.has(k) ? [{ ...byKey.get(k)!, visible: true }] : []));
    return [...picked, ...options.filter((o) => !selected.includes(o.key)).map((o) => ({ ...o, visible: false }))];
  });
  const i18n = useI18n();
  return (
    <Dialog open onClose={onClose} headerText={title} resizable className="confire-flush"
      style={{ width: "min(40rem, 95vw)", height: "min(36rem, 85vh)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" onClick={() => onConfirm(items.filter((i) => i.visible).map((i) => i.key))}>{i18n.getText("ADMIN_OK")}</Button>
            <Button design="Transparent" onClick={onClose}>{i18n.getText("ADMIN_CANCEL")}</Button>
          </>
        } />
      }>
      <ColumnsTab items={items} onChange={setItems} />
    </Dialog>
  );
}
