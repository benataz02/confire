import type { EntityFeature, Facet } from "@confire/ui/types.ts";
import { B1_FEATURES } from "./index.ts";

/** `i18n.getText` bound so `this` stays the bundle. */
export type AdminText = (key: string, ...args: Array<string | number>) => string;

const TITLE: Record<string, string> = {
  Quotations: "NAV_QUOTATIONS",
  Orders: "NAV_ORDERS",
  DeliveryNotes: "NAV_DELIVERIES",
  BusinessPartners: "NAV_BP",
  Items: "NAV_ITEMS",
};

const CREATE: Record<string, string> = {
  Quotations: "ADMIN_NEW_QUOTATION",
  Orders: "ADMIN_NEW_ORDER",
  DeliveryNotes: "ADMIN_NEW_DELIVERY",
  BusinessPartners: "ADMIN_NEW_BP",
  Items: "ADMIN_NEW_ITEM",
};

const SECTION: Record<string, string> = {
  general: "ADMIN_SECTION_GENERAL",
  notes: "ADMIN_SECTION_NOTES",
  lines: "ADMIN_SECTION_LINES",
  portal: "NAV_PORTAL",
};

const GROUP: Record<string, string> = {
  identity: "ADMIN_GROUP_BP",
  contact: "ADMIN_GROUP_CONTACT",
  sales: "ADMIN_GROUP_SALES",
  customer: "ADMIN_GROUP_CUSTOMER",
  dates: "ADMIN_GROUP_DATES",
  amounts: "ADMIN_GROUP_AMOUNTS",
  item: "ADMIN_GROUP_ITEM",
  units: "ADMIN_GROUP_UOM",
};

const VIEW: Record<string, string> = {
  default: "ADMIN_VIEW_STANDARD",
  open: "ADMIN_OPEN",
};

function docStatus(t: AdminText): NonNullable<Facet["statusMapping"]> {
  return {
    bost_Open: { state: "Information", text: t("ADMIN_OPEN") },
    bost_Close: { state: "None", text: t("ADMIN_DOC_CLOSED") },
    bost_Paid: { state: "Positive", text: t("ADMIN_DOC_PAID") },
    bost_Delivered: { state: "Positive", text: t("ADMIN_DOC_DELIVERED") },
  };
}

/** The same declared feature, with the titles a person reads. `B1_FEATURES` stays English:
 *  beforeLoad and the shell only need to know which entities exist. */
export function localizedB1Feature(entity: string, t: AdminText): EntityFeature | undefined {
  const f = B1_FEATURES[entity];
  if (!f) return;
  const title = TITLE[entity] ? t(TITLE[entity]) : f.label;
  return {
    ...f,
    label: title,
    list: {
      ...f.list,
      title,
      systemViews: f.list.systemViews?.map((v) => ({ ...v, name: VIEW[v.key] ? t(VIEW[v.key]!) : v.name })),
    },
    detail: {
      ...f.detail,
      header: {
        ...f.detail.header,
        createTitle: CREATE[entity] ? t(CREATE[entity]) : f.detail.header.createTitle,
        facets: f.detail.header.facets?.map((facet) =>
          facet.field === "DocumentStatus" ? { ...facet, statusMapping: docStatus(t) } : facet,
        ),
      },
      sections: f.detail.sections.map((s) => ({
        ...s,
        label: SECTION[s.id] ? t(SECTION[s.id]!) : s.label,
        groups: s.groups?.map((g) => ({ ...g, label: GROUP[g.id] ? t(GROUP[g.id]!) : g.label })),
        table: s.table && {
          ...s.table,
          columns: s.table.columns.map((c) => (c.key === "VisOrder" ? { ...c, label: t("ADMIN_COL_LINE_NO") } : c)),
        },
      })),
    },
  };
}
