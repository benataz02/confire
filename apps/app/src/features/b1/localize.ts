import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { EntityConstraints } from "@confire/ui/metadata.ts";
import type { EntityFeature, Facet } from "@confire/ui/types.ts";
import { orpc } from "../../orpc.ts";
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
      })),
    },
  };
}

const dataOf = <T>(results: { data?: T }[]) => results.map((r) => r.data);

/**
 * The feature's `codeNames` laid over its metadata as Options. The grid (cells, group rows, the
 * export), the filter, the form and the header all draw an option's label, so each shows the name;
 * until the read lands, or if it fails, they show the code as before. Typed `enum`, so a name is
 * not end-aligned like a number.
 * ponytail: one page of the code table (B1_PAGE_SIZE, 100); a code past it shows as itself —
 * follow nextCursor if a tenant has more groups than that.
 */
export function useCodeNames(feature: EntityFeature, c: EntityConstraints | undefined): EntityConstraints | undefined {
  const names = Object.entries(feature.codeNames ?? {});
  const data = useQueries({
    queries: names.map(([, n]) => ({
      ...orpc.entities.rows.queryOptions({
        input: { entity: n.entitySet, query: { select: [n.value, n.label], filter: [], orderby: [{ field: n.label, dir: "asc" as const }] } },
      }),
      staleTime: 5 * 60_000,
    })),
    combine: dataOf,
  });
  return useMemo(() => {
    if (!c) return c;
    let fields = c.fields;
    names.forEach(([key, n], i) => {
      const rows = data[i]?.rows;
      if (!rows || !fields[key]) return;
      const Options = rows.map((r) => ({ value: String(r[n.value]), label: String(r[n.label] ?? r[n.value]) }));
      fields = { ...fields, [key]: { ...fields[key], Type: "enum", Options } };
    });
    return fields === c.fields ? c : { ...c, fields };
  }, [c, data, feature]);
}
