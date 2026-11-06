import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { t, title } from "../../head.ts";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Button, FlexBox, HeroBanner, Icon, Title } from "@ui5/webcomponents-react";
import { meQuery, orpc, useCurrency, useIsAdmin } from "../../orpc.ts";
import { formatLocale } from "@confire/ui/format.ts";
import { useI18n } from "../../i18n.ts";
import { B1_DOCUMENTS, B1_FEATURES } from "../../features/b1/index.ts";
import { B1_NAV_KEY } from "../../components/AppShell.tsx";
import { formatValue } from "../../reports/widgets.ts";
import "./-home.css";

// The workspace home: the caller's own figures in the HeroBanner, then the side nav's groups as
// launchpad tiles. A tile's count is a to-do, and the tile opens its list filtered to exactly those
// rows (the list reads its filters off the URL), so the number and the list never disagree.
export const Route = createFileRoute("/$slug/")({ head: () => title(t("NAV_HOME")), component: Home });

type TileProps = {
  title: string;
  subtitle?: string;
  icon?: string;
  value?: string | number;
  unit?: string;
  state?: "Critical" | "Negative";
  /** tenant-relative (`/configs`); no `to` = a figure, not a link */
  to?: string;
  search?: Record<string, string>;
  wide?: boolean;
  /** the value is on its way: a shimmer bar (global.css' skeleton) holds its place */
  loading?: boolean;
};

function Tile({ to, search, wide, loading, ...c }: TileProps) {
  const body = (
    <>
      <span className="cf-tile-title">{c.title}</span>
      {c.subtitle && <span className="cf-tile-sub">{c.subtitle}</span>}
      <span className="cf-tile-foot">
        {c.icon && <Icon name={c.icon} className="cf-tile-icon" />}
        {loading && <span className="cf-tile-num"><span className="confire-op-skel-bar" style={{ width: "2.5rem", height: "2rem" }} /></span>}
        {!loading && c.value !== undefined && (
          <span className={`cf-tile-num ${c.state ?? ""}`}>{c.value}{c.unit && <small>{c.unit}</small>}</span>
        )}
      </span>
    </>
  );
  const className = wide ? "cf-tile cf-tile-wide" : "cf-tile";
  // A real <a>: keyboard, middle-click and "open in new tab" come with it.
  return to
    ? <Link to={`/$slug${to}` as string} search={search} className={className}>{body}</Link>
    : <div className={className}>{body}</div>;
}

const OPEN_DOC = { field: "DocumentStatus", op: "eq", value: "bost_Open" } as const;
const flag = (n: number | undefined, state: "Critical" | "Negative") => (n ? state : undefined);

function Home() {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const navigate = useNavigate({ from: "/$slug" });
  const isAdmin = useIsAdmin();
  const currency = useCurrency();
  const { data: me } = useQuery(meQuery);
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

  const firstName = (me?.user?.name || me?.user?.email || "").split(/[ @]/)[0]!;
  const hour = new Date().getHours();
  const greeting = t(hour < 12 ? "HOME_GREETING_MORNING" : hour < 18 ? "HOME_GREETING_AFTERNOON" : "HOME_GREETING_EVENING", firstName);
  const compact = new Intl.NumberFormat(formatLocale(), { notation: "compact", maximumFractionDigits: 1 });

  const groups: { title: string; tiles: TileProps[] }[] = [
    {
      title: t("NAV_CONFIGURATOR"),
      tiles: [
        // The chat alone, from the client's request to the quote page. Off, the page says why.
        { title: t("ASSISTANT_PAGE_TITLE"), subtitle: t("ASSISTANT_PAGE_SUB"), icon: "ai", to: "/assistant" },
        { title: t("NAV_CONFIGS"), subtitle: t("HOME_DRAFTS"), icon: "sales-quote", value: o?.drafts, to: "/configs", search: { status: "draft" } },
        ...(isAdmin ? [
          { title: t("NAV_MODELS"), icon: "tree", value: o?.models, to: "/models" },
          { title: t("NAV_MASTERDATA"), subtitle: t("HOME_SYNC_ERRORS"), icon: "table-view", value: o?.syncErrors, state: flag(o?.syncErrors, "Negative"), to: "/masterdata" },
        ] : []),
      ],
    },
    {
      title: t("HOME_REPORTS"),
      tiles: [
        // The AI page: a chat that asks for a report becomes the report's.
        { title: t("HOME_NEW_REPORT"), subtitle: t("HOME_NEW_REPORT_SUB"), icon: "add-document", to: "/assistant" },
        // The 11rem square holds the title and the figure. The report's subtitle stays on its page.
        ...(reports ?? []).map((r): TileProps => ({
          title: r.title || t("REPORT_UNTITLED"), icon: "business-objects-experience",
          value: r.value === null ? undefined : formatValue(r.value, r.format, r.currency, formatLocale()),
          to: `/reports/${r.id}`,
        })),
      ],
    },
    {
      title: t("NAV_PORTAL"),
      tiles: [
        { title: t("NAV_REQUESTS"), subtitle: t("HOME_NEW_REQUESTS"), icon: "inbox", value: o?.newRequests, state: flag(o?.newRequests, "Critical"), to: "/requests", search: { status: "submitted" } },
        ...(isAdmin ? [
          { title: t("NAV_INVITATIONS"), subtitle: t("HOME_OPEN"), icon: "paper-plane", value: o?.openInvitations, to: "/portal/invitations", search: { state: "pending" } },
        ] : []),
      ],
    },
    // A document's tile counts its open ones and opens its list on them; master data has no to-do.
    {
      title: t("NAV_SAP"),
      tiles: Object.values(B1_FEATURES).map((f) => ({
        title: B1_NAV_KEY[f.entity] ? t(B1_NAV_KEY[f.entity]!) : f.entity, icon: f.icon, to: `/b1/${f.entity}`,
        ...(B1_DOCUMENTS.has(f.entity) ? { subtitle: t("HOME_OPEN"), value: openCount[f.entity]!.data, loading: openCount[f.entity]!.isPending, search: { DocumentStatus: "bost_Open" } } : {}),
      })),
    },
  ];

  return (
    <FlexBox direction="Column" style={{ gap: "2rem", padding: "1rem 2rem 2rem" }}>
      <HeroBanner
        overlineText={new Date().toLocaleDateString(formatLocale(), { weekday: "long", day: "numeric", month: "long" })}
        headerText={greeting}
        actions={
          <Button icon="add" onClick={() => void navigate({ to: "/$slug/configs/new" })}>{t("CONFIG_NEW")}</Button>
        }
      >
        <div className="cf-tiles">
          <Tile wide title={t("HOME_MY_DRAFTS")} subtitle={t("HOME_MY_DRAFTS_SUB")} icon="edit"
            value={o?.myDrafts} to="/configs" search={{ status: "draft", mine: "yes" }} />
          <Tile wide title={t("HOME_MY_IN_REVIEW")} subtitle={t("HOME_MY_IN_REVIEW_SUB")} icon="inbox"
            value={o?.myInReview} to="/requests" search={{ status: "in_review", mine: "yes" }} />
          <Tile wide title={t("HOME_MY_QUOTED")}
            subtitle={o ? t(o.myQuoted === 1 ? "HOME_QUOTATIONS_ONE" : "HOME_QUOTATIONS_MANY", String(o.myQuoted)) : undefined}
            icon="sales-document" value={o ? compact.format(o.myQuotedValue) : undefined} unit={currency} />
        </div>
      </HeroBanner>

      {groups.map((g) => (
        <section key={g.title}>
          <Title level="H4" style={{ marginBottom: "0.75rem" }}>{g.title}</Title>
          <div className="cf-tiles">
            {g.tiles.map((tile) => <Tile key={tile.to ?? tile.title} {...tile} />)}
          </div>
        </section>
      ))}
    </FlexBox>
  );
}
