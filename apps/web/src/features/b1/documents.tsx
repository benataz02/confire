import { useMutation } from "@tanstack/react-query";
import { Button, MessageStrip } from "@ui5/webcomponents-react";
import { orpc } from "../../orpc.ts";
import { toast } from "../../components/toast.ts";
import { PrintActions } from "../../components/b1/PrintActions.tsx";
import { cfl } from "../../shared/cfl/cfl-configs.ts";
import { useEntityNav } from "../../shared/EntityLink.tsx";
import { toIsoDay } from "../../shared/format.ts";
import type { EntityFeature, Facet, HeaderActionContext } from "../../shared/types.ts";

// The B1 marketing documents, declared. One builder for all four: Quotations and Orders are
// writable, DeliveryNotes and Invoices read-only — which is the server's word (entities.metadata
// `writable`/`Editable`), not a flag here. Labels, types and options come from metadata; this file
// says which fields, in what layout, with which value helps and links.

/** B1's BoStatus member names (what the Service Layer sends) -> a status colour. */
export const DOCUMENT_STATUS: Facet["statusMapping"] = {
  bost_Open: { state: "Information", text: "Open" },
  bost_Close: { state: "None", text: "Closed" },
  bost_Paid: { state: "Positive", text: "Paid" },
  bost_Delivered: { state: "Positive", text: "Delivered" },
};

/** Print, and the copy flows out of this document (Quotation -> Order -> Delivery -> Invoice). */
function DocumentActions({ entity, scope, ctx }: { entity: string; scope: "internal" | "portal"; ctx: HeaderActionContext }) {
  const go = useEntityNav();
  const copy = useMutation(orpc.entities.copy.mutationOptions({
    onSuccess: (r) => {
      toast(`${r.entity} ${r.docNum ?? r.docEntry} created`);
      go(`/b1/${r.entity}`, r.docEntry);
    },
  }));
  if (ctx.isNew) return null;
  const docEntry = Number(ctx.formData.DocEntry);
  return (
    <>
      {ctx.constraints?.printable ? (
        <PrintActions entity={entity} docEntry={docEntry} scope={scope} disabled={ctx.isEditMode} />
      ) : null}
      {(ctx.constraints?.flows ?? []).map((f) => (
        <Button key={f.target} icon="copy" design="Transparent" disabled={copy.isPending || ctx.isEditMode}
          onClick={() => copy.mutate({ sourceEntity: entity, targetEntity: f.target, docEntry })}>
          {f.label}
        </Button>
      ))}
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
  scope?: "internal" | "portal";
}): EntityFeature {
  const scope = o.scope ?? "internal";
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
        actions: (ctx) => <DocumentActions entity={entity} scope={scope} ctx={ctx} />,
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
