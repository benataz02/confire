import type { ListQuery, ValueState } from "@confire/ui/types.ts";
import { PROJECT_STATUS, projectStatusLabel } from "@confire/ui/timeline/projectStatus.ts";

type ProjectStatus = keyof typeof PROJECT_STATUS;
import { DOCUMENT_STATUS, documentStatusText, statusState } from "@confire/ui/documentStatus.ts";
import { formatLocale } from "@confire/ui/format.ts";
import { money } from "@confire/ui/money.ts";
import { entityPath } from "@confire/ui/navigation.ts";

// A tool's output as card rows (pure; every label through `t`). The rows are the server's: a card
// draws them, it never asks the model for them.

/** A route under `/$slug`, with the list's URL filters. */
export type CardLink = { to: string; search?: Record<string, string> };
export type CardRow = {
  id: string; title: string; description?: string; info?: string; infoState?: ValueState; icon?: string; link?: CardLink;
};
export type ListCardData = { items: CardRow[]; total: number; openAll: CardLink | null };

type T = (key: string, ...a: Array<string | number>) => string;
type Page<R> = { rows: R[]; total?: number | null; nextSkip?: number };

const join = (...xs: (string | null | undefined)[]) => xs.filter((x) => x).join(" · ");

type ConfigRow = { id: string; name: string; status: ProjectStatus; customerName: string | null; modelName: string };
export function configItems(out: Page<ConfigRow>, t: T): ListCardData {
  return {
    items: out.rows.map((r) => ({
      id: r.id, title: r.name || "—", description: join(r.customerName, r.modelName),
      info: projectStatusLabel(r.status, t), infoState: PROJECT_STATUS[r.status]?.state, link: { to: `/configs/${r.id}` },
    })),
    total: out.total ?? out.rows.length,
    openAll: null,
  };
}

/** A client's request opens on the configuration process page, where staff work it. */
type RequestRow = { id: string; name: string; status: ProjectStatus; cardName: string; modelName: string };
export function requestItems(out: Page<RequestRow>, t: T): ListCardData {
  return {
    items: out.rows.map((r) => ({
      id: r.id, title: r.name || "—", description: join(r.cardName, r.modelName),
      info: projectStatusLabel(r.status, t), infoState: PROJECT_STATUS[r.status]?.state, link: { to: `/configs/${r.id}` },
    })),
    total: out.total ?? out.rows.length,
    openAll: null,
  };
}

const date = (v: unknown) => {
  const d = typeof v === "string" || v instanceof Date ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(formatLocale()) : "";
};

/** SAP rows. A link only where `canOpen` says the reader may open the page. */
export function documentItems(entity: string, out: Page<Record<string, unknown>>, canOpen: (route: string) => boolean, t: T): ListCardData {
  const route = `/b1/${entity}`;
  const may = canOpen(route);
  const items = out.rows.map((r, i): CardRow => {
    if (entity === "BusinessPartners") {
      const code = String(r.CardCode ?? "");
      return { id: code || String(i), title: String(r.CardName ?? code), description: code, ...(may && code ? { link: { to: entityPath(route, code) } } : {}) };
    }
    const status = String(r.DocumentStatus ?? "");
    return {
      id: String(r.DocEntry ?? i),
      title: String(r.DocNum ?? r.DocEntry ?? ""),
      description: join(String(r.CardName ?? ""), date(r.DocDate)),
      info: typeof r.DocTotal === "number" ? money(r.DocTotal, r.DocCurrency ? String(r.DocCurrency) : undefined) : undefined,
      infoState: statusState(status),
      ...(may && r.DocEntry !== undefined ? { link: { to: entityPath(route, r.DocEntry) } } : {}),
    };
  });
  return { items, total: out.total ?? out.rows.length, openAll: null };
}

/** A document's status as its card says it. */
export const documentStatus = (code: unknown, t: T) =>
  documentStatusText(String(code ?? ""), DOCUMENT_STATUS?.[String(code ?? "")]?.text, t);

/**
 * The list behind a card, with what of the tool's query its URL can carry: each `eq`/`in` as
 * `field=a,b` and the search, the format the list's `decodeFilters` reads.
 * ponytail: eq/in/search only; ranges when a card needs them.
 */
export function openAllOf(route: string, query: Pick<ListQuery, "filter"> & { search?: string } & Partial<ListQuery>): CardLink {
  const search: Record<string, string> = {};
  for (const f of query.filter) {
    if (f.op !== "eq" && f.op !== "in") continue;
    search[f.field] = (Array.isArray(f.value) ? f.value : [f.value]).map(String).join(",");
  }
  if (query.search?.trim()) search.search = query.search.trim();
  return { to: route, search };
}
