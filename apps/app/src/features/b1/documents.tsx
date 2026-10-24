import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Menu, MenuItem, MessageStrip, type ButtonDomRef } from "@ui5/webcomponents-react";
import { useI18n } from "../../i18n.ts";
import { orpc } from "../../orpc.ts";
import { toast } from "@confire/ui/toast.ts";
import { confirm } from "@confire/ui/confirm.ts";
import { PrintActions } from "@confire/ui/PrintActions.tsx";
import { DOCUMENT_STATUS } from "@confire/ui/documentStatus.ts";
import { cfl } from "@confire/ui/cfl/cfl-configs.ts";
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

const TARGET: Record<string, string> = {
  Orders: "ADMIN_TARGET_ORDER",
  DeliveryNotes: "ADMIN_TARGET_DELIVERY",
  Invoices: "ADMIN_TARGET_INVOICE",
};

/** Copy to: one button, the flows out of `entity` (Quotation -> Order -> Delivery -> Invoice) in its
 *  menu. Every row is a source — the Object Page's one record, or a List Report's selection, merged
 *  into one target, which B1 takes only from one business partner (the server checks again). It
 *  posts nothing: it opens the target's draft (`#copy` on the target's route), and Save there does. */
export function CopyTo({ entity, flows, rows, disabled }: {
  entity: string; flows: { target: string; label: string }[]; rows: Row[]; disabled?: boolean;
}) {
  const i18n = useI18n();
  const navigate = useNavigate({ from: "/$slug" });
  const opener = useRef<ButtonDomRef>(null);
  const [open, setOpen] = useState(false);
  if (!flows.length) return null;
  const partners = new Set(rows.map((r) => r.CardCode)).size;
  return (
    <>
      <Button ref={opener} icon="copy" endIcon="slim-arrow-down" design="Transparent"
        disabled={disabled || partners !== 1}
        tooltip={partners > 1 ? i18n.getText("ADMIN_COPY_ONE_PARTNER") : undefined}
        accessibilityAttributes={{ hasPopup: "menu", expanded: open }}
        onClick={() => setOpen(true)}>
        {i18n.getText("ADMIN_COPY_TO")}
      </Button>
      {open ? (
        <Menu open opener={opener.current} onClose={() => setOpen(false)}
          onItemClick={(e) => void navigate({
            to: "/$slug/b1/$entity",
            params: { entity: (e.detail.item as HTMLElement).dataset.target! },
            // The route keeps its search free-form (a list's filters live there), hence the cast.
            search: { from: entity, docs: rows.map((r) => r.DocEntry).join(",") } as never,
            hash: "copy",
          })}>
          {flows.map((f) => (
            <MenuItem key={f.target} data-target={f.target} text={TARGET[f.target] ? i18n.getText(TARGET[f.target]!) : f.label} />
          ))}
        </Menu>
      ) : null}
    </>
  );
}

/** Print, Copy to and (quotations) Close on the Object Page. */
function DocumentActions({ entity, ctx, hasPage }: { entity: string; ctx: HeaderActionContext; hasPage: (entity: string) => boolean }) {
  if (ctx.isNew) return null;
  const docEntry = Number(ctx.formData.DocEntry);
  return (
    <>
      {ctx.constraints?.printable ? (
        <PrintActions entity={entity} docEntry={docEntry} disabled={ctx.isEditMode} />
      ) : null}
      <CopyTo entity={entity} flows={(ctx.constraints?.flows ?? []).filter((f) => hasPage(f.target))} rows={[ctx.formData]} disabled={ctx.isEditMode} />
      {entity === "Quotations" ? <CloseQuotations rows={[ctx.formData]} disabled={ctx.isEditMode} /> : null}
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
  /** whether an entity has a page here: Copy to offers only those targets, its draft being one */
  hasPage: (entity: string) => boolean;
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
        actions: (ctx) => <DocumentActions entity={entity} ctx={ctx} hasPage={o.hasPage} />,
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
              { key: "VisualOrder", width: 60, readonly: true },
              {
                key: "ItemCode", width: 160, cflConfig: cfl.items(), linkConfig: { route: "/b1/Items" },
                onRowSelect: (row) => ({ ItemDescription: row.ItemName ?? null }),
              },
              { key: "ItemDescription" },
              { key: "Quantity", width: 110 },
              { key: "RemainingOpenQuantity", width: 110, readonly: true },
              { key: "WarehouseCode", width: 120, cflConfig: cfl.warehouses() },
              { key: "UnitPrice", width: 120 },
              { key: "DiscountPercent", width: 100 },
              { key: "LineTotal", width: 130, readonly: true },
              { key: "LineStatus", width: 110, readonly: true },
              // Offered in the grid's settings. The calculated ones are SAP's, never sent.
              { key: "ShipDate", width: 120, hidden: true },
              { key: "UoMCode", width: 100, hidden: true },
              { key: "VatGroup", width: 100, hidden: true },
              { key: "Price", width: 120, hidden: true, readonly: true },
              { key: "GrossTotal", width: 130, hidden: true, readonly: true },
              { key: "OpenAmount", width: 130, hidden: true, readonly: true },
              { key: "ProjectCode", width: 120, hidden: true },
              { key: "FreeText", hidden: true },
            ],
          },
        },
      ],
      // B1 refuses a document without a valid-until date; today + 30 is the usual quote validity.
      createDefaults: () => ({ DocDate: plusDays(0), DocDueDate: plusDays(30) }),
    },
  };
}
