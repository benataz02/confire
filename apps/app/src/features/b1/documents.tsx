import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, MessageStrip } from "@ui5/webcomponents-react";
import { useI18n } from "../../i18n.ts";
import { orpc } from "../../orpc.ts";
import { toast } from "@confire/ui/toast.ts";
import { confirm } from "@confire/ui/confirm.ts";
import { PrintActions } from "@confire/ui/PrintActions.tsx";
import { DOCUMENT_STATUS } from "@confire/ui/documentStatus.ts";
import { cfl } from "@confire/ui/cfl/cfl-configs.ts";
import { useEntityNav } from "@confire/ui/EntityLink.tsx";
import { toIsoDay } from "@confire/ui/format.ts";
import type { EntityFeature, HeaderActionContext, Row } from "@confire/ui/types.ts";

// The B1 marketing documents, declared. One builder for all four: Quotations and Orders are
// writable, DeliveryNotes and Invoices read-only — which is the server's word (entities.metadata
// `writable`/`Editable`), not a flag here. Labels, types and options come from metadata; this file
// says which fields, in what layout, with which value helps and links.

/** Close open quotations in SAP (spec §7.3): the Object Page's header action and the List Report's
 *  selection action. A re-quote of a client's request whose quotation is closed posts a new one,
 *  so closing is also how staff start a quotation over. Admins and owners — the server says so. */
export function CloseQuotations({ rows, disabled, onClosed }: { rows: Row[]; disabled?: boolean; onClosed?: () => void }) {
  const i18n = useI18n();
  const qc = useQueryClient();
  const close = useMutation(orpc.entities.close.mutationOptions());
  const open = rows.filter((r) => r.DocumentStatus === undefined || r.DocumentStatus === "bost_Open");
  const run = async () => {
    const one = open.length === 1;
    const ok = await confirm({
      title: i18n.getText(one ? "ADMIN_CLOSE_QUOTE_TITLE" : "ADMIN_CLOSE_QUOTES_TITLE"),
      message: one
        ? i18n.getText("ADMIN_CLOSE_QUOTE_MSG", String(open[0]!.DocNum ?? open[0]!.DocEntry))
        : i18n.getText("ADMIN_CLOSE_QUOTES_MSG", open.length),
      actionText: i18n.getText("ADMIN_CLOSE"), destructive: true,
    });
    if (!ok) return;
    // One at a time: each is its own SAP action, and the first refusal should stop the rest.
    let done = 0;
    try {
      for (const r of open) { await close.mutateAsync({ entity: "Quotations", key: Number(r.DocEntry) }); done++; }
    } finally {
      void qc.invalidateQueries({ queryKey: orpc.entities.one.key() });
      void qc.invalidateQueries({ queryKey: orpc.entities.rows.key() });
      if (done) { toast(done === 1 ? i18n.getText("ADMIN_QUOTE_CLOSED") : i18n.getText("ADMIN_QUOTES_CLOSED", done)); onClosed?.(); }
    }
  };
  return (
    <>
      <Button icon="locked" design="Transparent" disabled={disabled || close.isPending || !open.length}
        tooltip={open.length ? undefined : i18n.getText("ADMIN_CLOSE_ONLY_OPEN")} onClick={() => void run()}>
        {i18n.getText("ADMIN_CLOSE")}
      </Button>
      {close.error ? <MessageStrip design="Negative" hideCloseButton>{close.error.message}</MessageStrip> : null}
    </>
  );
}

const CREATED: Record<string, string> = {
  Orders: "ADMIN_CREATED_ORDER",
  DeliveryNotes: "ADMIN_CREATED_DELIVERY",
  Invoices: "ADMIN_CREATED_INVOICE",
};
const FLOW_KEY: Record<string, string> = {
  "Sales Quotation to Sales Order": "ADMIN_FLOW_QUOTE_TO_ORDER",
  "Sales Order to Delivery": "ADMIN_FLOW_ORDER_TO_DELIVERY",
  "Sales Order to Invoice": "ADMIN_FLOW_ORDER_TO_INVOICE",
  "Delivery to A/R Invoice": "ADMIN_FLOW_DELIVERY_TO_INVOICE",
};

/** Print, and the copy flows out of this document (Quotation -> Order -> Delivery -> Invoice). */
function DocumentActions({ entity, ctx }: { entity: string; ctx: HeaderActionContext }) {
  const i18n = useI18n();
  const go = useEntityNav();
  const copy = useMutation(orpc.entities.copy.mutationOptions({
    onSuccess: (r) => {
      const key = CREATED[r.entity];
      const num = String(r.docNum ?? r.docEntry);
      toast(key ? i18n.getText(key, num) : `${r.entity} ${num} created`);
      go(`/b1/${r.entity}`, r.docEntry);
    },
  }));
  if (ctx.isNew) return null;
  const docEntry = Number(ctx.formData.DocEntry);
  return (
    <>
      {ctx.constraints?.printable ? (
        <PrintActions entity={entity} docEntry={docEntry} disabled={ctx.isEditMode} />
      ) : null}
      {(ctx.constraints?.flows ?? []).map((f) => {
        const flow = FLOW_KEY[f.label];
        return (
          <Button key={f.target} icon="copy" design="Transparent" disabled={copy.isPending || ctx.isEditMode}
            onClick={() => copy.mutate({ sourceEntity: entity, targetEntity: f.target, docEntry })}>
            {flow ? i18n.getText(flow) : f.label}
          </Button>
        );
      })}
      {entity === "Quotations" ? <CloseQuotations rows={[ctx.formData]} disabled={ctx.isEditMode} /> : null}
      {copy.error ? <MessageStrip design="Negative" hideCloseButton>{copy.error.message}</MessageStrip> : null}
    </>
  );
}

const plusDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return toIsoDay(d);
};

/** Newest first — DocEntry, not DocNum, which restarts per series. */
const NEWEST = [{ field: "DocEntry", direction: "desc" as const }];

export function documentFeature(entity: string, o: {
  /** plural, the list's title */
  label: string;
  /** singular, lower case: "New <one>" */
  one: string;
  icon: string;
}): EntityFeature {
  return {
    entity,
    label: o.label,
    icon: o.icon,
    keyField: "DocEntry",
    list: {
      tableId: `b1:${entity}`,
      title: o.label,
      columns: [
        { key: "DocNum", width: 110 },
        { key: "CardCode", width: 140, groupable: true, linkConfig: { route: "/b1/BusinessPartners" } },
        { key: "CardName", groupable: true },
        { key: "DocDate", width: 120 },
        { key: "DocDueDate", width: 120 },
        { key: "NumAtCard" },
        { key: "DocumentStatus", width: 120, groupable: true },
        { key: "DocTotal", width: 130 },
        { key: "DocCurrency", width: 90, hidden: true },
      ],
      filterFields: [
        { key: "DocNum", exact: true },
        { key: "CardCode", cfl: { dialogConfig: cfl.customers() } },
        { key: "DocDate" },
        { key: "DocumentStatus" },
      ],
      systemViews: [
        { key: "default", name: "Standard", isDefault: true, state: { sortBy: NEWEST } },
        { key: "open", name: "Open", state: { sortBy: NEWEST, filterValues: { DocumentStatus: ["bost_Open"] } } },
      ],
    },
    detail: {
      header: {
        titleField: "DocNum",
        subtitleFields: ["CardName", "DocDate"],
        createTitle: `New ${o.one}`,
        facets: [
          { field: "DocumentStatus", type: "status", statusMapping: DOCUMENT_STATUS },
          { field: "DocTotal", type: "numeric", unitField: "DocCurrency" },
        ],
        actions: (ctx) => <DocumentActions entity={entity} ctx={ctx} />,
      },
      sections: [
        {
          id: "general",
          label: "General",
          groups: [
            {
              id: "customer",
              label: "Customer",
              fields: [
                {
                  key: "CardCode", cfl: { dialogConfig: cfl.customers() }, link: true,
                  onRowSelect: (row) => ({ CardName: row.CardName ?? null }),
                },
                { key: "CardName", readonly: true },
                { key: "NumAtCard" },
                { key: "SalesPersonCode", cfl: { dialogConfig: cfl.salesPersons() } },
              ],
            },
            {
              id: "dates",
              label: "Dates",
              fields: [{ key: "DocDate" }, { key: "DocDueDate" }, { key: "DocumentStatus", readonly: true }],
            },
            {
              id: "amounts",
              label: "Amounts",
              fields: [
                { key: "DocCurrency", cfl: { dialogConfig: cfl.currencies() } },
                { key: "DocTotal", readonly: true },
                { key: "Comments", controlType: "textarea" },
              ],
            },
          ],
        },
        {
          id: "lines",
          label: "Lines",
          table: {
            key: "DocumentLines",
            columns: [
              { key: "VisOrder", label: "#", width: 60, readonly: true },
              {
                key: "ItemCode", width: 160, cflConfig: cfl.items(), linkConfig: { route: "/b1/Items" },
                onRowSelect: (row) => ({ ItemDescription: row.ItemName ?? null }),
              },
              { key: "ItemDescription" },
              { key: "Quantity", width: 110 },
              { key: "UnitPrice", width: 120 },
              { key: "LineTotal", width: 130, readonly: true },
            ],
          },
        },
      ],
      // B1 refuses a document without a valid-until date; today + 30 is the usual quote validity.
      createDefaults: () => ({ DocDate: plusDays(0), DocDueDate: plusDays(30) }),
    },
  };
}
