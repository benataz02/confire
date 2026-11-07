import { useEffect, useState } from "react";
import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { SearchItem, SearchItemGroup, SearchMessageArea, SearchScope, ShellBarSearch } from "@ui5/webcomponents-react";
import { useEntityNav } from "@confire/ui/EntityLink.tsx";
import { formatValue } from "@confire/ui/format.ts";
import type { ListQuery } from "@confire/ui/types.ts";
import { orpc } from "../orpc.ts";
import { useI18n } from "../i18n.ts";
import { DOC_PAGES, type DocEntity } from "../features/documents.ts";

/** One thing the search opens: `to` is a path inside the portal, as the side nav's `data-to`. */
export type SearchHit = { text: string; description?: string; icon: string; to: string };
type Group = { key: string; header: string; hits: SearchHit[] };
type Recent = SearchHit & { scope: string };

const ALL = "all";
const CAP = { all: 5, scoped: 20 };
const RECENT_KEEP = 10;
const DOCS = Object.keys(DOC_PAGES) as DocEntity[];

const recentKey = (slug: string) => `portal.search.recent.${slug}`;
function readRecent(slug: string): Recent[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(recentKey(slug)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((r): r is Recent => typeof r?.to === "string" && typeof r?.text === "string") : [];
  } catch {
    return [];
  }
}

/** As the staff search's B1 query: a number is a DocNum (an integer, which contains() cannot match);
 *  text searches every string field the supplier shows its clients (empty select = the portal schema). */
const docQuery = (term: string): ListQuery => {
  const orderby = [{ field: "DocEntry", dir: "desc" as const }];
  return /^\d+$/.test(term)
    ? { select: [], filter: [{ field: "DocNum", op: "eq", value: Number(term) }], orderby }
    : { select: [], filter: [], orderby, search: term };
};

// The shellbar's search over the client's own portal: the pages, its projects and its four document
// types — each source its list's own procedure with `query.search`, so the fence is the list's.
// ponytail: the staff GlobalSearch's shape without chats or Show more; one shared @confire/ui shell
// once a third copy (or a fix in both) makes the duplication cost something.
export function PortalSearch({ pages }: { pages: SearchHit[] }) {
  const i18n = useI18n();
  const t = (key: string, ...args: string[]) => i18n.getText(key, ...args);
  const go = useEntityNav();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => { const id = setTimeout(() => setTerm(q.trim()), 250); return () => clearTimeout(id); }, [q]);
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState(ALL);
  const { slug } = useParams({ from: "/$slug" });
  const [recent, setRecent] = useState(() => readRecent(slug));
  const remember = (hit: Recent) => {
    const next = [hit, ...recent.filter((r) => r.to !== hit.to)].slice(0, RECENT_KEEP);
    localStorage.setItem(recentKey(slug), JSON.stringify(next));
    setRecent(next);
  };

  const cap = scope === ALL ? CAP.all : CAP.scoped;
  const on = (s: string) => !!term && (scope === ALL || scope === s);
  const opts = { placeholderData: keepPreviousData, retry: false } as const;
  const projects = useQuery({
    ...orpc.projects.rows.queryOptions({ input: { query: { select: [], filter: [], orderby: [], search: term }, top: cap } }),
    enabled: on("projects"), ...opts,
  });
  const docs = useQueries({
    queries: DOCS.map((entity) => ({
      ...orpc.docs.rows.queryOptions({ input: { entity, query: docQuery(term) } }),
      enabled: on("docs"), ...opts,
    })),
  });

  // A disabled source still holds its placeholder, so `on` gates what is drawn as well as what is read.
  const hits = <T,>(s: string, rows: T[] | undefined, hit: (r: T) => SearchHit) =>
    on(s) ? (rows ?? []).slice(0, cap).map(hit) : [];
  const needle = q.trim().toLowerCase();
  const results: Group[] = [
    {
      key: "pages", header: t("PORTAL_SEARCH_PAGES"),
      hits: needle && (scope === ALL || scope === "pages")
        ? pages.filter((p) => `${p.text} ${p.description ?? ""}`.toLowerCase().includes(needle)).slice(0, cap) : [],
    },
    { key: "projects", header: t("PORTAL_PROJECTS"), hits: hits("projects", projects.data?.rows, (r) =>
      ({ text: r.name, description: r.modelName, icon: "product", to: `/projects/${r.id}` })) },
    ...DOCS.map((entity, i) => ({
      key: `docs:${entity}`, header: t(DOC_PAGES[entity].labelKey),
      hits: hits("docs", docs[i]?.data?.rows, (r) => ({
        text: t(DOC_PAGES[entity].numKey, String(r.DocNum)),
        description: typeof r.DocDate === "string" ? formatValue(r.DocDate, "date") : undefined,
        icon: DOC_PAGES[entity].icon,
        to: `/docs/${entity}/${String(r.DocEntry)}`,
      })),
    })),
  ].filter((g) => g.hits.length);
  const latest = recent.filter((r) => scope === ALL || r.scope === scope);
  const groups: Group[] = needle ? results
    : latest.length ? [{ key: "recent", header: t("PORTAL_SEARCH_RECENT"), hits: latest }] : [];
  const pick = (to: string): Recent | undefined =>
    groups.flatMap((g) => g.hits.map((h) => ({ scope: g.key.split(":")[0]!, ...h }))).find((h) => h.to === to);

  const busy = q.trim() !== term || [projects, ...docs].some((r) => r.isFetching);

  return (
    <ShellBarSearch
      slot="searchField"
      className="confire-shellbar-search"
      value={q}
      showClearIcon
      noTypeahead
      autoOpen
      open={open && (!!needle || groups.length > 0)}
      onClick={(e) => { if (e.nativeEvent.composedPath()[0] instanceof HTMLInputElement) setOpen(true); }}
      fieldLoading={busy}
      scopeValue={scope}
      scopes={
        <>
          <SearchScope value={ALL} text={t("PORTAL_SEARCH_ALL")} />
          <SearchScope value="pages" text={t("PORTAL_SEARCH_PAGES")} />
          <SearchScope value="projects" text={t("PORTAL_PROJECTS")} />
          <SearchScope value="docs" text={t("PORTAL_DOCUMENTS")} />
        </>
      }
      messageArea={!busy && term && !groups.length ? <SearchMessageArea text={t("PORTAL_SEARCH_NONE")} /> : undefined}
      onScopeChange={(e) => setScope((e.detail.scope as HTMLElement & { value?: string } | undefined)?.value ?? ALL)}
      onInput={(e) => { setQ(e.target.value ?? ""); setOpen(true); }}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      // Enter and an item's click are both `search`, the item in its detail; empty Enter with no
      // item goes on to UI5, which collapses the field.
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
