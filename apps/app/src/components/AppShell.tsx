import { useNavigate, useRouter, useRouterState, Outlet } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Avatar, Button,
  NavigationLayout, ShellBar, ShellBarBranding, SideNavigation, SideNavigationGroup, SideNavigationItem,
  ToggleButton,
  UserMenu,
  UserMenuAccount,
  UserMenuItem,
} from "@ui5/webcomponents-react";
import type { SideNavigationPropTypes, NavigationLayoutDomRef, NavigationLayoutPropTypes } from "@ui5/webcomponents-react";
import { authClient } from "../auth-client.ts";
import { meQuery, notifications, useIsAdmin } from "../orpc.ts";
import { authUrl, hardRedirect, tenantPath } from "@confire/ui/host.ts";
import { useEntityNav } from "@confire/ui/EntityLink.tsx";
import { NotificationsPopover, useUnreadCount } from "@confire/ui/notifications/Notifications.tsx";
import { B1_FEATURES } from "../features/b1/index.ts";
import { GlobalSearch, type SearchEntry } from "./GlobalSearch.tsx";
import { useRef, useState, useMemo } from "react";
import type { MouseEvent } from "react";
import { THEMES, useAppearance } from "@confire/ui/appearance.ts";
import { LANGUAGES, useLanguage } from "@confire/ui/i18n.ts";
import { useI18n } from "../i18n.ts";

export const B1_NAV_KEY: Record<string, string> = {
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
// are paths inside the workspace.
export function AppShell() {
  const go = useEntityNav();
  const router = useRouter();
  const navigate = useNavigate({ from: "/$slug" });
  const openNotificationSettings = () => void navigate({ to: "/$slug/settings", search: { tab: "notifications" } });
  const pathname = useRouterState({ select: (s) => tenantPath(s.location.pathname) });
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const navLayoutRef = useRef<NavigationLayoutDomRef>(null);
  const [navMode, setNavMode] = useState<NavigationLayoutPropTypes["mode"]>("Auto");
  // Read the real collapsed state off the ref so the first click is correct on any screen size,
  // keeping "Auto" responsiveness until the user takes manual control.
  const toggleNav = () => setNavMode(navLayoutRef.current?.isSideCollapsed() ? "Expanded" : "Collapsed");
  // Touching the page content collapses the nav. One delegated listener on the layout rather than a
  // wrapper around <Outlet /> — the content slot sizes its own child, so an extra div breaks it.
  // The chrome is excluded by host tag: shadow-DOM retargeting means a click anywhere inside the
  // side nav / shellbar / user menu surfaces as that host element.
  const collapseOnContentClick = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("ui5-side-navigation, ui5-shellbar, ui5-user-menu")) return;
    if (!navLayoutRef.current?.isSideCollapsed()) setNavMode("Collapsed");
  };
  const { theme, setTheme: setThemeState, density, setDensity } = useAppearance();
  const i18n = useI18n();
  const { language, setLanguage } = useLanguage();

  // Identity + org role in one query, already primed by $slug's beforeLoad — a cache read.
  // Role decides whether the Settings item shows; the server gates it too.
  const me = useQuery(meQuery);
  const user = me.data?.user;
  const isAdmin = useIsAdmin();
  const queryClient = useQueryClient();
  // The bell (notifications spec §10): the count polls, the list loads while the popover is open.
  const unread = useUnreadCount(notifications);
  const [bellOpener, setBellOpener] = useState<HTMLElement | null>(null);

  const onSelect: SideNavigationPropTypes["onSelectionChange"] = (e) => {
    const to = (e.detail.item as HTMLElement).dataset.to;
    if (to) go(to);
  };

  // What the shellbar search can reach besides objects: the same targets as the side nav, plus the
  // appearance settings that otherwise only live in the user menu.
  const searchEntries = useMemo<SearchEntry[]>(() => {
    // `group` is a stable section id. GlobalSearch translates the header, and the scope filter
    // compares ids, so a language switch does not empty the list.
    const page = (text: string, to: string, icon: string) => ({ group: "Menus", text, icon, run: () => go(to) });
    const label = (key: string) => i18n.getText(key);
    return [
      page(label("NAV_CONFIGS"), "/configs", "sales-quote"),
      page(label("SHELL_SEARCH_PORTAL_REQUESTS"), "/requests", "inbox"),
      ...(isAdmin
        ? [
            ...Object.values(B1_FEATURES).map((f) => {
              const navKey = B1_NAV_KEY[f.entity];
              return {
                group: "Menus" as const,
                text: navKey ? label(navKey) : f.entity,
                description: label("NAV_SAP"),
                icon: f.icon,
                run: () => go(`/b1/${f.entity}`),
              };
            }),
            page(label("NAV_MODELS"), "/models", "tree"),
            page(label("SHELL_SEARCH_MASTERDATA"), "/masterdata", "table-view"),
            page(label("SHELL_SEARCH_PORTAL_INVITATIONS"), "/portal/invitations", "paper-plane"),
          ]
        : []),
      page(label("NAV_SETTINGS"), "/settings", "action-settings"),
      ...THEMES.map((item) => {
        const themeKey = THEME_KEY[item.id];
        return {
          group: "Settings",
          text: themeKey ? label(themeKey) : item.label,
          description: label("SHELL_SEARCH_THEME"),
          icon: "palette",
          run: () => setThemeState(item.id),
        };
      }),
      { group: "Settings", text: label("NAV_COMPACT"), description: label("USER_MENU_DENSITY"), icon: "resize-horizontal", run: () => setDensity('compact') },
      { group: "Settings", text: label("NAV_COZY"), description: label("USER_MENU_DENSITY"), icon: "resize-horizontal", run: () => setDensity('cozy') },
      ...LANGUAGES.map((l) => ({
        group: "Settings", text: l.label, description: label("USER_MENU_LANGUAGE"), icon: "translate",
        run: () => setLanguage(l.id),
      })),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, go, i18n]);

  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear(); // drop session + role caches, not just the session
    void hardRedirect(authUrl("/login")); // a page load: nothing of this workspace stays in memory
  };

  return (
    <NavigationLayout
      ref={navLayoutRef}
      mode={navMode}
      onClick={collapseOnContentClick}
      header={
        <>
          <ShellBar
            startButton={
              <>
                <Button
                  icon="nav-back"
                  tooltip={i18n.getText("SHELL_BACK")}
                  onClick={() => router.history.back()}
                />
                <Button
                  icon="menu2"
                  tooltip={i18n.getText("SHELL_MENU")}
                  onClick={toggleNav}
                />
              </>
            }
            branding={
              <ShellBarBranding logo={<img alt="Confire" src="/confire-logo.png" />}
                onClick={() => go("/")}>
                Confire
              </ShellBarBranding>
            }
            content={<GlobalSearch entries={searchEntries} isAdmin={isAdmin} />}
            profile={<Avatar id="user-menu-opener" initials='BA' />}
            onProfileClick={() => setUserMenuOpen((open) => !open)}
            showNotifications
            notificationsCount={unread ? String(unread) : undefined}
            onNotificationsClick={(e) => {
              const target = e.detail.targetRef;
              setBellOpener((cur) => (cur ? null : target));
            }}
            assistant={<ToggleButton icon="da" tooltip="Joule" />}
            accessibilityAttributes={{
              notifications: { expanded: bellOpener !== null, hasPopup: "dialog" },
              profile: { expanded: userMenuOpen, hasPopup: "menu" },
            }}
          >
          </ShellBar>
          <UserMenu
            open={userMenuOpen}
            opener="user-menu-opener"
            onClose={() => setUserMenuOpen(false)}
            onSignOutClick={signOut}
            accounts={
              <UserMenuAccount
                avatarInitials={user?.name?.substring(0, 2).toUpperCase() ?? 'U'}
                titleText={user?.name}
                description={user?.email}
              />
            }
            showEditAccounts
            showEditButton
            showManageAccount
            showOtherAccounts
          >
            <UserMenuItem text={i18n.getText("NAV_THEMES")} icon="person-placeholder" >
              {THEMES.map((item) => {
                const themeKey = THEME_KEY[item.id];
                return (
                  <UserMenuItem
                    key={item.id}
                    text={themeKey ? i18n.getText(themeKey) : item.label}
                    icon={theme === item.id ? "sys-enter" : ""}
                    onClick={() => setThemeState(item.id)}
                  >
                  </UserMenuItem>
                );
              })}
            </UserMenuItem>
            <UserMenuItem text={i18n.getText("USER_MENU_DENSITY")} icon="person-placeholder" >
              <UserMenuItem
                data-id="compact"
                text={i18n.getText("NAV_COMPACT")}
                icon={density === "compact" ? "sys-enter" : ""}
                onClick={() => setDensity('compact')}
              >
              </UserMenuItem>
              <UserMenuItem
                data-id="cozy"
                text={i18n.getText("NAV_COZY")}
                icon={density === "cozy" ? "sys-enter" : ""}
                onClick={() => setDensity('cozy')}
              >
              </UserMenuItem>
            </UserMenuItem>
            <UserMenuItem text={i18n.getText("USER_MENU_LANGUAGE")} icon="translate">
              {LANGUAGES.map((l) => (
                <UserMenuItem key={l.id} text={l.label} icon={language === l.id ? "sys-enter" : ""}
                  onClick={() => setLanguage(l.id)} />
              ))}
            </UserMenuItem>
            <UserMenuItem text={i18n.getText("NOTIF_MENU")} icon="bell"
              onClick={() => { setUserMenuOpen(false); openNotificationSettings(); }} />
          </UserMenu>
          <NotificationsPopover api={notifications} opener={bellOpener} open={bellOpener !== null}
            onClose={() => setBellOpener(null)} getText={i18n.getText.bind(i18n)}
            onNavigate={go} onSettings={openNotificationSettings} />
        </>
      }
      sideContent={
        <SideNavigation
          onSelectionChange={onSelect}
          fixedItems={
            <SideNavigationItem text={i18n.getText("NAV_SETTINGS")} icon="action-settings" data-to="/settings"
              selected={pathname === "/settings"} />
          }
        >
          {isAdmin ? (
                <SideNavigationGroup text={i18n.getText("NAV_SAP")} expanded>
                  {Object.values(B1_FEATURES).map((f) => {
                    const navKey = B1_NAV_KEY[f.entity];
                    return (
                      <SideNavigationItem key={f.entity}
                        text={navKey ? i18n.getText(navKey) : f.entity}
                        icon={f.icon}
                        data-to={`/b1/${f.entity}`}
                        selected={pathname === `/b1/${f.entity}` || pathname.startsWith(`/b1/${f.entity}/`)} />
                    );
                  })}
                </SideNavigationGroup>
              ) : null}
              <SideNavigationGroup text={i18n.getText("NAV_CONFIGURATOR")} expanded>
                <SideNavigationItem
                  text={i18n.getText("NAV_CONFIGS")}
                  icon="sales-quote"
                  data-to="/configs"
                  selected={pathname === "/configs" || pathname.startsWith("/configs/")}
                />
                {isAdmin ? (
                  <>
                    <SideNavigationItem
                      text={i18n.getText("NAV_MODELS")}
                      icon="tree"
                      data-to="/models"
                      selected={pathname === "/models" || pathname.startsWith("/models/")}
                    />
                    <SideNavigationItem
                      text={i18n.getText("NAV_MASTERDATA")}
                      icon="table-view"
                      data-to="/masterdata"
                      selected={pathname === "/masterdata" || pathname.startsWith("/masterdata/")}
                    />
                  </>
                ) : null}
              </SideNavigationGroup>
              {/* The customer portal (spec §10): Requests for every member, the rest for admins. */}
              <SideNavigationGroup text={i18n.getText("NAV_PORTAL")} expanded>
                <SideNavigationItem text={i18n.getText("NAV_REQUESTS")} icon="inbox" data-to="/requests"
                  selected={pathname === "/requests"} />
                {isAdmin ? (
                  <SideNavigationItem text={i18n.getText("NAV_INVITATIONS")} icon="paper-plane" data-to="/portal/invitations"
                    selected={pathname === "/portal/invitations"} />
                ) : null}
              </SideNavigationGroup>
        </SideNavigation>
      }
    >
      <Outlet />
    </NavigationLayout>
  );
}
