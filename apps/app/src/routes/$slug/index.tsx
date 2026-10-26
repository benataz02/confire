import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button, FlexBox, HeroBanner, Icon, Title } from "@ui5/webcomponents-react";
import { meQuery, orpc, useCurrency, useIsAdmin } from "../../orpc.ts";
import { formatLocale } from "@confire/ui/format.ts";
import { useI18n } from "../../i18n.ts";
import { B1_FEATURES } from "../../features/b1/index.ts";
import { B1_NAV_KEY } from "../../components/AppShell.tsx";
import "./-home.css";

// The workspace home: the caller's own figures in the HeroBanner, then the side nav's groups as
// launchpad tiles. A tile's count is a to-do, and the tile opens its list filtered to exactly those
// rows (the list reads its filters off the URL), so the number and the list never disagree.
export const Route = createFileRoute("/$slug/")({ component: Home });

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
};

function Tile({ to, search, wide, ...c }: TileProps) {
  const body = (
    <>
      <span className="cf-tile-title">{c.title}</span>
      {c.subtitle && <span className="cf-tile-sub">{c.subtitle}</span>}
      <span className="cf-tile-foot">
        {c.icon && <Icon name={c.icon} className="cf-tile-icon" />}
        {c.value !== undefined && (
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

const flag = (n: number | undefined, state: "Critical" | "Negative") => (n ? state : undefined);

function Home() {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const navigate = useNavigate({ from: "/$slug" });
  const isAdmin = useIsAdmin();
  const currency = useCurrency();
  const { data: me } = useQuery(meQuery);
  const { data: o } = useQuery(orpc.home.overview.queryOptions());

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
      title: t("NAV_PORTAL"),
      tiles: [
        { title: t("NAV_REQUESTS"), subtitle: t("HOME_NEW_REQUESTS"), icon: "inbox", value: o?.newRequests, state: flag(o?.newRequests, "Critical"), to: "/requests", search: { status: "submitted" } },
        ...(isAdmin ? [
          { title: t("NAV_INVITATIONS"), subtitle: t("HOME_OPEN"), icon: "paper-plane", value: o?.openInvitations, to: "/portal/invitations", search: { state: "pending" } },
        ] : []),
      ],
    },
    // SAP pages open live lists: a count would be a call to the agent, which the home never makes.
    {
      title: t("NAV_SAP"),
      tiles: Object.values(B1_FEATURES).map((f) => ({
        title: B1_NAV_KEY[f.entity] ? t(B1_NAV_KEY[f.entity]!) : f.entity, icon: f.icon, to: `/b1/${f.entity}`,
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
            {g.tiles.map((tile) => <Tile key={tile.title} {...tile} />)}
          </div>
        </section>
      ))}
    </FlexBox>
  );
}
