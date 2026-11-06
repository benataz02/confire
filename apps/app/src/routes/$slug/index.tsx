import { createFileRoute } from "@tanstack/react-router";
import { t, title } from "../../head.ts";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ObjectPage, ObjectPageSection, ObjectPageTitle, Text, Title } from "@ui5/webcomponents-react";
import { Tile, type TileProps } from "@confire/ui/Tile.tsx";
import { useGreeting } from "@confire/ui/greeting.ts";
import { meQuery, orpc, useCurrency, useIsAdmin } from "../../orpc.ts";
import { formatLocale } from "@confire/ui/format.ts";
import { useI18n } from "../../i18n.ts";
import { B1_DOCUMENTS, B1_FEATURES } from "../../features/b1/index.ts";
import { b1Label } from "../../components/AppShell.tsx";
import { formatValue } from "../../reports/widgets.ts";

// The workspace home, the portal home's layout: the caller's own figures first, then the side nav's
// groups, each a section of launchpad tiles. A tile's count is a to-do, and the tile opens its list
// filtered to exactly those rows (the list reads its filters off the URL), so the number and the list
// never disagree.
export const Route = createFileRoute("/$slug/")({ head: () => title(t("NAV_HOME")), component: Home });

const OPEN_DOC = { field: "DocumentStatus", op: "eq", value: "bost_Open" } as const;
const flag = (n: number | undefined, state: "Critical" | "Negative") => (n ? state : undefined);

function Home() {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const isAdmin = useIsAdmin();
  const currency = useCurrency();
  const { greeting, today } = useGreeting(useQuery(meQuery).data?.user);
  const { data: o } = useQuery(orpc.home.overview.queryOptions());
  // The user's saved reports, each its last run's headline: no SAP call here (reports spec §6.1).
  const { data: reports } = useQuery(orpc.reports.tiles.queryOptions());
  // Open documents per SAP list: live reads through the agent, each its own query, so the page never
  // waits on them and an agent that is down just leaves the tiles without a number.
  const b1Docs = Object.values(B1_FEATURES).filter((f) => B1_DOCUMENTS.has(f.entity));
  const openDocs = useQueries({
    queries: b1Docs.map((f) => ({
      ...orpc.entities.rows.queryOptions({ input: { entity: f.entity, count: true, query: { select: ["DocEntry"], filter: [OPEN_DOC], orderby: [] } } }),
      retry: false,
      select: (r: { total?: number }) => r.total,
    })),
  });
  const openCount = Object.fromEntries(b1Docs.map((f, i) => [f.entity, openDocs[i]!]));

  const groups: { id: string; title: string; tiles: TileProps[] }[] = [
    {
      id: "actions", title: t("HOME_QUICK_ACTIONS"),
      tiles: [
        { title: t("CONFIG_NEW"), icon: "add", to: "/configs/new" },
        { title: t("HOME_MY_DRAFTS"), subtitle: t("HOME_MY_DRAFTS_SUB"), icon: "edit", value: o?.myDrafts, to: "/configs", search: { status: "draft", mine: "yes" } },
        { title: t("HOME_MY_IN_REVIEW"), subtitle: t("HOME_MY_IN_REVIEW_SUB"), icon: "inbox", value: o?.myInReview, to: "/requests", search: { status: "in_review", mine: "yes" } },
        // A figure, not a link: the report tiles' compact money ("€12.3K"), on a 2×1 — a square's
        // number has no room for "123,5 mil €" beside the icon.
        {
          title: t("HOME_MY_QUOTED"), icon: "sales-document", wide: true,
          subtitle: o && t(o.myQuoted === 1 ? "HOME_QUOTATIONS_ONE" : "HOME_QUOTATIONS_MANY", String(o.myQuoted)),
          value: o && formatValue(o.myQuotedValue, "money", currency ?? null, formatLocale()),
        },
      ],
    },
    {
      id: "configurator", title: t("NAV_CONFIGURATOR"),
      tiles: [
        { title: t("NAV_CONFIGS"), subtitle: t("HOME_DRAFTS"), icon: "sales-quote", value: o?.drafts, to: "/configs", search: { status: "draft" } },
        ...(isAdmin ? [
          { title: t("NAV_MODELS"), icon: "tree", value: o?.models, to: "/models" },
          { title: t("NAV_MASTERDATA"), subtitle: t("HOME_SYNC_ERRORS"), icon: "table-view", value: o?.syncErrors, state: flag(o?.syncErrors, "Negative"), to: "/masterdata" },
        ] : []),
      ],
    },
    {
      id: "reports", title: t("HOME_REPORTS"),
      tiles: [
        // The 11rem square holds the title and the figure. The report's subtitle stays on its page.
        ...(reports ?? []).map((r): TileProps => ({
          title: r.title || t("REPORT_UNTITLED"), icon: "business-objects-experience",
          value: r.value === null ? undefined : formatValue(r.value, r.format, r.currency, formatLocale()),
          to: `/reports/${r.id}`,
        })),
      ],
    },
    {
      id: "portal", title: t("NAV_PORTAL"),
      tiles: [
        { title: t("NAV_REQUESTS"), subtitle: t("HOME_NEW_REQUESTS"), icon: "inbox", value: o?.newRequests, state: flag(o?.newRequests, "Critical"), to: "/requests", search: { status: "submitted" } },
        ...(isAdmin ? [
          { title: t("NAV_INVITATIONS"), subtitle: t("HOME_OPEN"), icon: "paper-plane", value: o?.openInvitations, to: "/portal/invitations", search: { state: "pending" } },
        ] : []),
      ],
    },
    // A document's tile counts its open ones and opens its list on them; master data has no to-do.
    {
      id: "sap", title: t("NAV_SAP"),
      tiles: Object.values(B1_FEATURES).map((f) => ({
        title: b1Label(f.entity, t), icon: f.icon, to: `/b1/${f.entity}`,
        ...(B1_DOCUMENTS.has(f.entity) ? { subtitle: t("HOME_OPEN"), value: openCount[f.entity]!.data, loading: openCount[f.entity]!.isPending, search: { DocumentStatus: "bost_Open" } } : {}),
      })),
    },
  ];

  // A section with no tiles (Reports, before a report is saved) is left out.
  const shown = groups.filter((g) => g.tiles.length);
  return (
    <ObjectPage hidePinButton titleArea={<ObjectPageTitle header={<Title>{greeting}</Title>} subHeader={<Text>{today}</Text>} />}>
      {shown.map((g) => (
        <ObjectPageSection key={g.id} id={g.id} titleText={g.title}>
          <div className="cf-tiles">
            {g.tiles.map((tile) => <Tile key={tile.to ?? tile.title} {...tile} />)}
          </div>
        </ObjectPageSection>
      ))}
    </ObjectPage>
  );
}
