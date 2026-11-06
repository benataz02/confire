import { useNavigate, useRouter, useRouterState, Outlet } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Avatar, Button, NavigationLayout, ShellBar, ShellBarBranding, SideNavigation, SideNavigationGroup, SideNavigationItem,
  ToggleButton, UserMenu, UserMenuAccount, UserMenuItem,
} from "@ui5/webcomponents-react";
import type { SideNavigationPropTypes, NavigationLayoutDomRef, NavigationLayoutPropTypes } from "@ui5/webcomponents-react";
import { authClient } from "../auth-client.ts";
import { client, meQuery, notifications, orpc, useIsAdmin } from "../orpc.ts";
import { authUrl, hardRedirect, tenantPath } from "@confire/ui/host.ts";
import { initials } from "@confire/ui/format.ts";
import { useEntityNav } from "@confire/ui/EntityLink.tsx";
import { NotificationsPopover, useUnreadCount } from "@confire/ui/notifications/Notifications.tsx";
import { B1_FEATURES } from "../features/b1/index.ts";
import { GlobalSearch, type SearchHit } from "./GlobalSearch.tsx";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { cfl } from "@confire/ui/cfl/cfl-configs.ts";
import { THEMES, useAppearance } from "@confire/ui/appearance.ts";
import { LANGUAGES, useLanguage } from "@confire/ui/i18n.ts";
import { useI18n } from "../i18n.ts";
import { AssistantProvider, useAssistantShell } from "../assistant/AssistantProvider.tsx";
import { assistantToggle } from "../assistant/toggle.ts";

const CflDialog = lazy(() => import("@confire/ui/cfl/CflDialog.tsx"));

/** The user's own B1 sales employee — the server's SALES_PERSON_KEY (ui-views.ts), which the SAP
 *  lists' "Assigned to me" filters SalesPersonCode on. */
const SALES_PERSON_KEY = "b1:salesPerson";

const B1_NAV_KEY: Record<string, string> = {
  Quotations: "NAV_QUOTATIONS",
  Orders: "NAV_ORDERS",
  DeliveryNotes: "NAV_DELIVERIES",
  BusinessPartners: "NAV_BP",
  Items: "NAV_ITEMS",
};
/** A declared B1 entity's list, as the side nav names it. */
export const b1Label = (entity: string, t: (key: string) => string) => {
  const key = B1_NAV_KEY[entity];
  return key ? t(key) : entity;
};

const THEME_KEY: Record<string, string> = {
  sap_horizon: "SHELL_THEME_MORNING_HORIZON",
  sap_horizon_dark: "SHELL_THEME_EVENING_HORIZON",
  sap_horizon_hcb: "SHELL_THEME_HCB",
  sap_horizon_hcw: "SHELL_THEME_HCW",
  sap_horizon_auto: "SHELL_THEME_AUTO",
  sap_horizon_hc_auto: "SHELL_THEME_HC_AUTO",
  sap_fiori_3: "SHELL_THEME_QUARTZ_LIGHT",
  sap_fiori_3_dark: "SHELL_THEME_QUARTZ_DARK",
  sap_fiori_3_hcb: "SHELL_THEME_QUARTZ_HCB",
  sap_fiori_3_hcw: "SHELL_THEME_QUARTZ_HCW",
};

// The app shell for every signed-in page. The workspace is the path's first segment; the auth gate
// lives in the $slug route (beforeLoad), this only renders the chrome. Nav targets and `pathname`
// are paths inside the workspace. The assistant's panel is shell state, around it all.
export function AppShell() {
  return <AssistantProvider><Shell /></AssistantProvider>;
}

function Shell() {
  const go = useEntityNav();
  const router = useRouter();
  const navigate = useNavigate({ from: "/$slug" });
  const openNotificationSettings = () => void navigate({ to: "/$slug/settings", search: { tab: "notifications" } });
  const pathname = useRouterState({ select: (s) => tenantPath(s.location.pathname) });
  /** On the page `to` or one under it (`/configs/…`); home only on itself. */
  const at = (to: string) => pathname === to || (to !== "/" && pathname.startsWith(`${to}/`));
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const navLayoutRef = useRef<NavigationLayoutDomRef>(null);
  // The user's last choice survives a reload (same localStorage as theme and density); "Auto" —
  // UI5's responsive default — only until they first press the menu button.
  const [navMode, setNavMode] = useState<NavigationLayoutPropTypes["mode"]>(
    () => (localStorage.getItem("navMode") as NavigationLayoutPropTypes["mode"] | null) ?? "Auto");
  // Read the real collapsed state off the ref so the first click is correct on any screen size.
  const toggleNav = () => {
    const next = navLayoutRef.current?.isSideCollapsed() ? "Expanded" : "Collapsed";
    localStorage.setItem("navMode", next);
    setNavMode(next);
  };
  const { theme, setTheme: setThemeState, density, setDensity } = useAppearance();
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const { language, setLanguage } = useLanguage();
  const assistant = useAssistantShell();
  // Off here (the workspace's switch, or no API key on the server): the toggle is disabled and says why.
  const assistantStatus = useQuery(orpc.assistant.status.queryOptions());
  const toggle = assistantToggle(assistantStatus.data, t);
  const { open: assistantOpen, close: closeAssistant } = assistant;
  const onAiPage = at("/assistant");
  useEffect(() => { if (toggle.disabled && assistantOpen && assistantStatus.data) closeAssistant(); },
    [toggle.disabled, assistantOpen, assistantStatus.data, closeAssistant]);

  // Identity + org role in one query, already primed by $slug's beforeLoad — a cache read.
  // Role decides the model builder, master data and invitations. SAP pages and Settings show for
  // every member; Settings itself sends a non-admin to Notifications.
  const me = useQuery(meQuery);
  const user = me.data?.user;
  const isAdmin = useIsAdmin();
  const queryClient = useQueryClient();
  // The bell (notifications spec §10): the count polls, the list loads while the popover is open.
  const unread = useUnreadCount(notifications);
  const [bellOpener, setBellOpener] = useState<HTMLElement | null>(null);
  const salesPersonState = orpc.views.getState.queryOptions({ input: { key: SALES_PERSON_KEY } });
  const salesPerson = useQuery(salesPersonState).data as { code: number; name: string } | null | undefined;
  const [pickingSalesPerson, setPickingSalesPerson] = useState(false);
  const pickSalesPerson = async (row: Record<string, unknown>) => {
    setPickingSalesPerson(false);
    await client.views.setState({ key: SALES_PERSON_KEY, value: { code: Number(row.SalesEmployeeCode), name: String(row.SalesEmployeeName ?? "") } });
    void queryClient.invalidateQueries({ queryKey: salesPersonState.queryKey });
    void queryClient.invalidateQueries({ queryKey: orpc.entities.rows.key() });
  };

  const onSelect: SideNavigationPropTypes["onSelectionChange"] = (e) => {
    const to = (e.detail.item as HTMLElement).dataset.to;
    if (to) go(to);
  };

  // The side nav, which is also the search's pages: one list, the admin cut made once.
  const home: SearchHit = { text: t("NAV_HOME"), icon: "home", to: "/" };
  const settings: SearchHit = { text: t("NAV_SETTINGS"), icon: "action-settings", to: "/settings" };
  const groups: { text: string; items: SearchHit[] }[] = [
    { text: t("NAV_SAP"), items: Object.values(B1_FEATURES).map((f) => ({ text: b1Label(f.entity, t), icon: f.icon, to: `/b1/${f.entity}` })) },
    {
      text: t("NAV_CONFIGURATOR"), items: [
        { text: t("NAV_CONFIGS"), icon: "sales-quote", to: "/configs" },
        ...(isAdmin ? [
          { text: t("NAV_MODELS"), icon: "tree", to: "/models" },
          { text: t("NAV_MASTERDATA"), icon: "table-view", to: "/masterdata" },
        ] : []),
      ],
    },
    // The assistant for every member; what it costs for admins (assistant spec §4.7).
    {
      text: t("NAV_AI"), items: [
        { text: t("ASSISTANT_PAGE_TITLE"), icon: "ai", to: "/assistant" },
        ...(isAdmin ? [{ text: t("NAV_AI_USAGE"), icon: "area-chart", to: "/usage" }] : []),
      ],
    },
    // The customer portal (spec §10): Requests for every member, the rest for admins.
    {
      text: t("NAV_PORTAL"), items: [
        { text: t("NAV_REQUESTS"), icon: "inbox", to: "/requests" },
        ...(isAdmin ? [{ text: t("NAV_INVITATIONS"), icon: "paper-plane", to: "/portal/invitations" }] : []),
      ],
    },
  ];
  const searchPages = [home, ...groups.flatMap((g) => g.items.map((i) => ({ ...i, description: g.text }))), settings];
  const navItem = (i: SearchHit) => <SideNavigationItem key={i.to} text={i.text} icon={i.icon} data-to={i.to} selected={at(i.to)} />;

  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear(); // drop session + role caches, not just the session
    void hardRedirect(authUrl("/login")); // a page load: nothing of this workspace stays in memory
  };

  return (
    <NavigationLayout
      ref={navLayoutRef}
      mode={navMode}
      header={
        <>
          <ShellBar
            startButton={
              <>
                <Button icon="nav-back" tooltip={t("SHELL_BACK")} onClick={() => router.history.back()} />
                <Button icon="menu2" tooltip={t("SHELL_MENU")} onClick={toggleNav} />
              </>
            }
            branding={
              <ShellBarBranding logo={<img alt="Confire" src="/confire-logo.png" />} onClick={() => go("/")}>
                Confire
              </ShellBarBranding>
            }
            searchField={<GlobalSearch pages={searchPages} isAdmin={isAdmin} />}
            showSearchField
            profile={<Avatar id="user-menu-opener" initials={initials(user?.name ?? "")}>
              {user?.image ? <img src={user.image} alt={user.name} /> : null}
            </Avatar>}
            onProfileClick={() => setUserMenuOpen((open) => !open)}
            showNotifications
            notificationsCount={unread ? String(unread) : undefined}
            onNotificationsClick={(e) => {
              const target = e.detail.targetRef;
              setBellOpener((cur) => (cur ? null : target));
            }}
            // On the AI configuration page the chat is the page: the toggle shows it, and has nothing to switch.
            assistant={<ToggleButton icon="da" pressed={assistant.open || onAiPage} disabled={toggle.disabled || onAiPage}
              tooltip={toggle.tooltip} accessibleName={toggle.tooltip} accessibilityAttributes={{ expanded: assistant.open || onAiPage }}
              onClick={assistant.toggle} />}
            accessibilityAttributes={{
              notifications: { expanded: bellOpener !== null, hasPopup: "dialog" },
              profile: { expanded: userMenuOpen, hasPopup: "menu" },
            }}
          />
          <UserMenu
            open={userMenuOpen}
            opener="user-menu-opener"
            onClose={() => setUserMenuOpen(false)}
            onSignOutClick={signOut}
            accounts={
              <UserMenuAccount
                avatarInitials={initials(user?.name ?? "")}
                avatarSrc={user?.image ?? undefined}
                titleText={user?.name}
                description={user?.email}
              />
            }
            showEditAccounts
            showEditButton
          >
            <UserMenuItem text={t("NAV_THEMES")} icon="person-placeholder">
              {THEMES.map((item) => (
                <UserMenuItem key={item.id} text={THEME_KEY[item.id] ? t(THEME_KEY[item.id]!) : item.label}
                  icon={theme === item.id ? "sys-enter" : ""} onClick={() => setThemeState(item.id)} />
              ))}
            </UserMenuItem>
            <UserMenuItem text={t("USER_MENU_DENSITY")} icon="person-placeholder">
              <UserMenuItem text={t("NAV_COMPACT")} icon={density === "compact" ? "sys-enter" : ""} onClick={() => setDensity("compact")} />
              <UserMenuItem text={t("NAV_COZY")} icon={density === "cozy" ? "sys-enter" : ""} onClick={() => setDensity("cozy")} />
            </UserMenuItem>
            <UserMenuItem text={t("USER_MENU_LANGUAGE")} icon="translate">
              {LANGUAGES.map((l) => (
                <UserMenuItem key={l.id} text={l.label} icon={language === l.id ? "sys-enter" : ""}
                  onClick={() => setLanguage(l.id)} />
              ))}
            </UserMenuItem>
            <UserMenuItem text={t("NOTIF_MENU")} icon="bell"
              onClick={() => { setUserMenuOpen(false); openNotificationSettings(); }} />
            <UserMenuItem icon="customer"
              text={salesPerson ? t("USER_MENU_SALES_PERSON_IS", salesPerson.name) : t("USER_MENU_SALES_PERSON")}
              onClick={() => { setUserMenuOpen(false); setPickingSalesPerson(true); }} />
          </UserMenu>
          {pickingSalesPerson && (
            <Suspense fallback={null}>
              <CflDialog config={cfl.salesPersons({ title: t("USER_MENU_SALES_PERSON") })} initialSearch="" multiSelect={false}
                onClose={() => setPickingSalesPerson(false)} onSelect={([row]) => { if (row) void pickSalesPerson(row); }} />
            </Suspense>
          )}
          <NotificationsPopover api={notifications} opener={bellOpener} open={bellOpener !== null}
            onClose={() => setBellOpener(null)} getText={t}
            onNavigate={go} onSettings={openNotificationSettings} />
        </>
      }
      sideContent={
        <SideNavigation onSelectionChange={onSelect} fixedItems={navItem(settings)}>
          {navItem(home)}
          {groups.map((g) => (
            <SideNavigationGroup key={g.text} text={g.text} expanded>{g.items.map(navItem)}</SideNavigationGroup>
          ))}
        </SideNavigation>
      }
    >
      <Outlet />
    </NavigationLayout>
  );
}
