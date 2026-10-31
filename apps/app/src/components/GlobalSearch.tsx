import { useEffect, useState } from "react";
import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { SearchItem, SearchItemGroup, SearchMessageArea, SearchScope, ShellBarSearch } from "@ui5/webcomponents-react";
import { useEntityNav } from "@confire/ui/EntityLink.tsx";
import { entityPath } from "@confire/ui/navigation.ts";
import { formatValue } from "@confire/ui/format.ts";
import type { EntityFeature, ListQuery, Row } from "@confire/ui/types.ts";
import { orpc } from "../orpc.ts";
import { useI18n } from "../i18n.ts";
import { B1_FEATURES } from "../features/b1/index.ts";
import { b1Label } from "./AppShell.tsx";

/** One thing the search opens: `to` is a path inside the workspace, as the side nav's `data-to`. */
export type SearchHit = { text: string; description?: string; icon: string; to: string };
type Group = { key: string; header: string; hits: SearchHit[] };

const ALL = "all";
// Unscoped, one group cannot bury the others; scoped, there is one list, so let it breathe.
const CAP = { all: 5, scoped: 20 };
const ISO_DAY = /^\d{4}-\d\d-\d\d/;
const cell = (v: unknown) => (typeof v === "string" && ISO_DAY.test(v) ? formatValue(v, "date") : String(v));
const join = (...v: unknown[]) => v.filter((x) => x != null && x !== "").map(cell).join(" · ") || undefined;

/** A B1 list's search, as the list itself searches: its visible string columns (the server keeps the
 *  strings of `select`), in its Standard view's order. A number is a document's DocNum instead — an
 *  integer, which B1's contains() cannot match. */
function b1Query(f: EntityFeature, term: string): ListQuery {
  const h = f.detail.header;
  const select = [...new Set([f.keyField, h.titleField, ...(h.subtitleFields ?? []),
    ...f.list.columns.filter((c) => !c.hidden).map((c) => c.key)])];
  const orderby = (f.list.systemViews?.find((v) => v.isDefault)?.state?.sortBy ?? [])
    .map((s) => ({ field: s.field, dir: s.direction }));
  return /^\d+$/.test(term) && h.titleField === "DocNum"
    ? { select, filter: [{ field: "DocNum", op: "eq", value: Number(term) }], orderby }
    : { select, filter: [], orderby, search: term };
}

// The shellbar's search over everything a staff member can open: the pages, SAP's declared lists,
// configurations, requests, models and master data (admins), and the user's own chats. Every source is
// its list's own procedure with `query.search`, so the server's permission is the list's; each group
// fills in as its source answers, and SAP (the slowest, through the agent) comes last so nothing jumps.
// ponytail: one call per source per settled term (B1's page is its fixed 100 rows, cut here); a server
// `search` procedure once that fan-out shows up in the agent's load.
export function GlobalSearch({ pages, isAdmin }: { pages: SearchHit[]; isAdmin: boolean }) {
  const i18n = useI18n();
  const t = (key: string) => i18n.getText(key);
  const go = useEntityNav();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => { const id = setTimeout(() => setTerm(q.trim()), 250); return () => clearTimeout(id); }, [q]);
  const [open, setOpen] = useState(false);
  // The AI page has no chat list of its own: there this search is it, scoped to chats, and pulses on
  // arrival so it is noticed. Leaving the page puts the scope back.
  const onAiPage = useRouterState({ select: (s) => s.matches.some((m) => m.routeId.startsWith("/$slug/assistant")) });
  const [scope, setScope] = useState(onAiPage ? "chats" : ALL);
  useEffect(() => setScope(onAiPage ? "chats" : ALL), [onAiPage]);

  const cap = scope === ALL ? CAP.all : CAP.scoped;
  const on = (s: string, allowed = true) => !!term && allowed && (scope === ALL || scope === s);
  // keepPreviousData: the last term's hits stay up while the next one loads, instead of a blink.
  const opts = { placeholderData: keepPreviousData, retry: false } as const;
  const page = { query: { select: [], filter: [], orderby: [], search: term }, top: cap };
  const configs = useQuery({ ...orpc.configs.rows.queryOptions({ input: page }), enabled: on("configs"), ...opts });
  const requests = useQuery({ ...orpc.requests.rows.queryOptions({ input: page }), enabled: on("requests"), ...opts });
  const chats = useQuery({ ...orpc.assistant.threads.queryOptions({ input: { q: term } }), enabled: on("chats"), ...opts });
  const models = useQuery({ ...orpc.models.rows.queryOptions({ input: page }), enabled: on("models", isAdmin), ...opts });
  const masterdata = useQuery({ ...orpc.masterdata.rows.queryOptions({ input: page }), enabled: on("masterdata", isAdmin), ...opts });
  const features = Object.values(B1_FEATURES);
  const b1 = useQueries({
    queries: features.map((f) => ({
      ...orpc.entities.rows.queryOptions({ input: { entity: f.entity, query: b1Query(f, term) } }),
      enabled: on("b1"), ...opts,
    })),
  });

  // A disabled source still holds its placeholder, so `on` gates what is drawn as well as what is read.
  const hits = <T,>(s: string, rows: T[] | undefined, hit: (r: T) => SearchHit, allowed = true) =>
    on(s, allowed) ? (rows ?? []).slice(0, cap).map(hit) : [];
  const needle = q.trim().toLowerCase();
  const groups: Group[] = [
    {
      key: "pages", header: t("SHELL_SEARCH_PAGES"),
      hits: needle && (scope === ALL || scope === "pages")
        ? pages.filter((p) => `${p.text} ${p.description ?? ""}`.toLowerCase().includes(needle)).slice(0, cap) : [],
    },
    { key: "configs", header: t("NAV_CONFIGS"), hits: hits("configs", configs.data?.rows, (r) =>
      ({ text: r.name, description: join(r.customerName, r.modelName), icon: "sales-quote", to: `/configs/${r.id}` })) },
    { key: "requests", header: t("NAV_REQUESTS"), hits: hits("requests", requests.data?.rows, (r) =>
      ({ text: r.name, description: join(r.cardName, r.modelName), icon: "inbox", to: `/configs/${r.id}` })) },
    { key: "chats", header: t("SHELL_SEARCH_CHATS"), hits: hits("chats", chats.data, (r) =>
      ({ text: r.title, description: join(r.projectName), icon: "ai", to: `/assistant/${r.id}` })) },
    { key: "models", header: t("NAV_MODELS"), hits: hits("models", models.data?.rows, (r) =>
      ({ text: r.name, icon: "tree", to: `/models/${r.id}` }), isAdmin) },
    { key: "masterdata", header: t("NAV_MASTERDATA"), hits: hits("masterdata", masterdata.data?.rows, (r) =>
      ({ text: r.name, description: join(r.source), icon: "table-view", to: `/masterdata/${r.id}` }), isAdmin) },
    ...features.map((f, i) => ({
      key: `b1:${f.entity}`, header: b1Label(f.entity, t),
      hits: hits("b1", b1[i]?.data?.rows, (r: Row) => ({
        text: String(r[f.detail.header.titleField] ?? r[f.keyField]),
        description: join(...(f.detail.header.subtitleFields ?? []).map((k) => r[k])),
        icon: f.icon,
        to: entityPath(`/b1/${f.entity}`, r[f.keyField]),
      })),
    })),
  ].filter((g) => g.hits.length);

  const busy = q.trim() !== term || [configs, requests, chats, models, masterdata, ...b1].some((r) => r.isFetching);

  return (
    <ShellBarSearch
      slot="searchField"
      className={onAiPage ? "confire-shellbar-search confire-search-pulse" : "confire-shellbar-search"}
      value={q}
      showClearIcon
      noTypeahead
      open={open && !!q.trim()}
      fieldLoading={busy}
      scopeValue={scope}
      scopes={
        <>
          <SearchScope value={ALL} text={t("SHELL_SEARCH_ALL")} />
          <SearchScope value="pages" text={t("SHELL_SEARCH_PAGES")} />
          <SearchScope value="configs" text={t("NAV_CONFIGS")} />
          <SearchScope value="requests" text={t("NAV_REQUESTS")} />
          <SearchScope value="chats" text={t("SHELL_SEARCH_CHATS")} />
          {isAdmin ? <SearchScope value="models" text={t("NAV_MODELS")} /> : null}
          {isAdmin ? <SearchScope value="masterdata" text={t("NAV_MASTERDATA")} /> : null}
          <SearchScope value="b1" text={t("NAV_SAP")} />
        </>
      }
      messageArea={!busy && term && !groups.length ? <SearchMessageArea text={t("SHELL_SEARCH_NONE")} /> : undefined}
      onScopeChange={(e) => setScope((e.detail.scope as HTMLElement & { value?: string } | undefined)?.value ?? ALL)}
      onInput={(e) => { setQ(e.target.value ?? ""); setOpen(true); }}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      // Enter and an item's click are both `search`, the item (picked or arrowed to) in its detail.
      // Empty Enter goes on to UI5, which collapses the field, as a shellbar search does.
      onSearch={(e) => {
        const to = (e.detail as { item?: HTMLElement } | undefined)?.item?.dataset.to ?? groups[0]?.hits[0]?.to;
        if (!q.trim() || !to) return;
        e.preventDefault();
        setQ("");
        setTerm("");
        setOpen(false);
        go(to);
      }}
    >
      {groups.map((g) => (
        <SearchItemGroup key={g.key} headerText={g.header}>
          {g.hits.map((h) => (
            <SearchItem key={h.to} data-to={h.to} text={h.text} description={h.description} icon={h.icon} />
          ))}
        </SearchItemGroup>
      ))}
    </ShellBarSearch>
  );
}
