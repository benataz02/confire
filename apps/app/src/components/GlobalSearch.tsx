import { useCallback, useEffect, useRef, useState } from "react";
import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { useParams, useRouterState } from "@tanstack/react-router";
import {
  SearchItem, SearchItemGroup, SearchItemShowMore, SearchMessageArea, SearchScope, ShellBarSearch,
} from "@ui5/webcomponents-react";
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
/** A hit once picked, with the scope it was found under (a group's key up to its `:`). */
type Recent = SearchHit & { scope: string };

const ALL = "all";
// Unscoped, one group cannot bury the others; scoped, there is one list, so let it breathe.
const CAP = { all: 5, scoped: 20 };
// The empty field's list: this many first, as many more per Show more, never more than KEEP.
const RECENT = { step: 5, keep: 20 };

// ponytail: localStorage per workspace, like the model builder's collapsed rows — a ui_user_state
// key only if the history has to follow the user to another browser.
const recentKey = (slug: string) => `search.recent.${slug}`;
function readRecent(slug: string): Recent[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(recentKey(slug)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((r): r is Recent => typeof r?.to === "string" && typeof r?.text === "string") : [];
  } catch {
    return [];
  }
}
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
  const { slug } = useParams({ from: "/$slug" });
  const [recent, setRecent] = useState(() => readRecent(slug));
  const remember = (hit: Recent) => {
    const next = [hit, ...recent.filter((r) => r.to !== hit.to)].slice(0, RECENT.keep);
    localStorage.setItem(recentKey(slug), JSON.stringify(next));
    setRecent(next);
  };
  // How many of the empty field's list are drawn; each opening starts again at one step.
  const [shown, setShown] = useState(RECENT.step);
  useEffect(() => { if (!open) setShown(RECENT.step); }, [open]);

  const cap = scope === ALL ? CAP.all : CAP.scoped;
  const on = (s: string, allowed = true) => !!term && allowed && (scope === ALL || scope === s);
  // keepPreviousData: the last term's hits stay up while the next one loads, instead of a blink.
  const opts = { placeholderData: keepPreviousData, retry: false } as const;
  const page = { query: { select: [], filter: [], orderby: [], search: term }, top: cap };
  const configs = useQuery({ ...orpc.configs.rows.queryOptions({ input: page }), enabled: on("configs"), ...opts });
  const requests = useQuery({ ...orpc.requests.rows.queryOptions({ input: page }), enabled: on("requests"), ...opts });
  const chats = useQuery({ ...orpc.assistant.threads.queryOptions({ input: { q: term } }), enabled: on("chats"), ...opts });
  // The AI page's own list (same key), so an empty field there offers the latest chats.
  const latestChats = useQuery({ ...orpc.assistant.threads.queryOptions({ input: undefined }), enabled: open && scope === "chats" && !q.trim() });
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
  const chatHit = (r: { id: string; title: string; projectName: string | null }) => ({
    text: r.title || r.projectName || t("ASSISTANT_UNTITLED"), description: join(r.projectName), icon: "ai", to: `/assistant/${r.id}`,
  });
  // The empty field: scoped to chats, the AI page's list (pinned first, as there); else what was
  // picked here last under this scope.
  const latest: Recent[] = scope === "chats"
    ? (latestChats.data ?? []).map((r) => ({ ...chatHit(r), scope: "chats" }))
    : recent.filter((r) => scope === ALL || r.scope === scope);
  const results: Group[] = [
    {
      key: "pages", header: t("SHELL_SEARCH_PAGES"),
      hits: needle && (scope === ALL || scope === "pages")
        ? pages.filter((p) => `${p.text} ${p.description ?? ""}`.toLowerCase().includes(needle)).slice(0, cap) : [],
    },
    { key: "configs", header: t("NAV_CONFIGS"), hits: hits("configs", configs.data?.rows, (r) =>
      ({ text: r.name, description: join(r.customerName, r.modelName), icon: "sales-quote", to: `/configs/${r.id}` })) },
    { key: "requests", header: t("NAV_REQUESTS"), hits: hits("requests", requests.data?.rows, (r) =>
      ({ text: r.name, description: join(r.cardName, r.modelName), icon: "inbox", to: `/configs/${r.id}` })) },
    { key: "chats", header: t("SHELL_SEARCH_CHATS"), hits: hits("chats", chats.data, chatHit) },
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
  const groups: Group[] = needle ? results
    : latest.length ? [{ key: "recent", header: t(scope === "chats" ? "SHELL_SEARCH_RECENT_CHATS" : "SHELL_SEARCH_RECENT"), hits: latest }] : [];
  // A picked hit keeps the scope it was found under; a recent one already carries its own.
  const pick = (to: string): Recent | undefined =>
    groups.flatMap((g) => g.hits.map((h) => ({ scope: g.key.split(":")[0]!, ...h }))).find((h) => h.to === to);

  // Show more takes focus to the first item it revealed, as Fiori asks — and the row itself goes
  // once everything is shown, which would otherwise drop focus out of the popover.
  const revealed = useRef<number | null>(null);
  const focusRevealed = useCallback((el: HTMLElement | null) => {
    console.log("DBG ref", el?.tagName, (el as { text?: string } | null)?.text, el?.isConnected);
    if (el) { revealed.current = null; void el.focus(); }
  }, []);

  const busy = q.trim() !== term || latestChats.isLoading
    || [configs, requests, chats, models, masterdata, ...b1].some((r) => r.isFetching);

  return (
    <ShellBarSearch
      slot="searchField"
      className={onAiPage ? "confire-shellbar-search confire-search-pulse" : "confire-shellbar-search"}
      value={q}
      showClearIcon
      noTypeahead
      // Opens on focus, with the empty field's list; a click into the field reopens it after Escape.
      autoOpen
      open={open && (!!needle || groups.length > 0)}
      onClick={(e) => { if (e.nativeEvent.composedPath()[0] instanceof HTMLInputElement) setOpen(true); }}
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
      // Empty Enter with no item goes on to UI5, which collapses the field, as a shellbar search does.
      onSearch={(e) => {
        const to = (e.detail as { item?: HTMLElement } | undefined)?.item?.dataset.to ?? (needle ? groups[0]?.hits[0]?.to : undefined);
        if (!to) return;
        e.preventDefault();
        const hit = pick(to);
        if (hit) remember(hit);
        setQ("");
        setTerm("");
        setOpen(false);
        go(to);
      }}
    >
      {groups.map((g) => {
        const more = g.key === "recent" ? g.hits.length - shown : 0;
        return (
          <SearchItemGroup key={g.key} headerText={g.header}>
            {(more > 0 ? g.hits.slice(0, shown) : g.hits).map((h, i) => (
              <SearchItem key={h.to} data-to={h.to} text={h.text} description={h.description} icon={h.icon}
                ref={g.key === "recent" && i === revealed.current ? focusRevealed : undefined} />
            ))}
            {more > 0 ? (
              <SearchItemShowMore itemsToShowCount={Math.min(RECENT.step, more)}
                onClick={() => { revealed.current = shown; setShown(shown + RECENT.step); }} />
            ) : null}
          </SearchItemGroup>
        );
      })}
    </ShellBarSearch>
  );
}
