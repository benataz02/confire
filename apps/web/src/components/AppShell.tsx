import { useRouter, useRouterState, Outlet } from "@tanstack/react-router";
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
import { meQuery, useIsAdmin } from "../orpc.ts";
import { authUrl, hardRedirect, tenantPath } from "@confire/ui/host.ts";
import { useEntityNav } from "@confire/ui/EntityLink.tsx";
import { B1_FEATURES } from "../features/b1/index.ts";
import { GlobalSearch, type SearchEntry } from "./GlobalSearch.tsx";
import { useRef, useState, useMemo } from "react";
import type { MouseEvent } from "react";
import { THEMES, useAppearance } from "@confire/ui/appearance.ts";


// The app shell for every signed-in page. The workspace is the path's first segment; the auth gate
// lives in the $slug route (beforeLoad), this only renders the chrome. Nav targets and `pathname`
// are paths inside the workspace.
export function AppShell() {
  const go = useEntityNav();
  const router = useRouter();
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

  // Identity + org role in one query, already primed by $slug's beforeLoad — a cache read.
  // Role decides whether the Settings item shows; the server gates it too.
  const me = useQuery(meQuery);
  const user = me.data?.user;
  const isAdmin = useIsAdmin();
  const queryClient = useQueryClient();

  const onSelect: SideNavigationPropTypes["onSelectionChange"] = (e) => {
    const to = (e.detail.item as HTMLElement).dataset.to;
    if (to) go(to);
  };

  // What the shellbar search can reach besides objects: the same targets as the side nav, plus the
  // appearance settings that otherwise only live in the user menu.
  const searchEntries = useMemo<SearchEntry[]>(() => {
    const page = (text: string, to: string, icon: string) => ({ group: "Menus", text, icon, run: () => go(to) });
    return [
      page("Home", "/", "home"),
      page("Configurations", "/configs", "sales-quote"),
      page("Portal requests", "/requests", "inbox"),
      ...(isAdmin
        ? [
            ...Object.values(B1_FEATURES).map((f) => ({
              group: "Menus" as const,
              text: f.label,
              description: "SAP Business One",
              icon: f.icon,
              run: () => go(`/b1/${f.entity}`),
            })),
            page("Configurator models", "/models", "tree"),
            page("Masterdata", "/masterdata", "table-view"),
            page("Portal invitations", "/portal/invitations", "paper-plane"),
            page("Settings", "/settings", "action-settings"),
          ]
        : []),
      ...THEMES.map((t) => ({
        group: "Settings", text: t.label, description: "Theme", icon: "palette",
        run: () => setThemeState(t.id),
      })),
      { group: "Settings", text: "Compact", description: "Density", icon: "resize-horizontal", run: () => setDensity('compact') },
      { group: "Settings", text: "Cozy", description: "Density", icon: "resize-horizontal", run: () => setDensity('cozy') },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, go]);

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
                  tooltip='Back'
                  onClick={() => router.history.back()}
                />
                <Button
                  icon="menu"
                  tooltip='Menu'
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
            assistant={<ToggleButton icon="da" tooltip="Joule" />}
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
            <UserMenuItem text="Themes" icon="person-placeholder" >
              {THEMES.map((t) => (
                <UserMenuItem
                  key={t.id}
                  text={t.label}
                  icon={theme === t.id ? "sys-enter" : ""}
                  onClick={() => setThemeState(t.id)}
                >
                </UserMenuItem>
              ))}
            </UserMenuItem>
            <UserMenuItem text="Density" icon="person-placeholder" >
              <UserMenuItem
                data-id="compact"
                text="Compact"
                icon={density === "compact" ? "sys-enter" : ""}
                onClick={() => setDensity('compact')}
              >
              </UserMenuItem>
              <UserMenuItem
                data-id="cozy"
                text="Cozy"
                icon={density === "cozy" ? "sys-enter" : ""}
                onClick={() => setDensity('cozy')}
              >
              </UserMenuItem>
            </UserMenuItem>
          </UserMenu>
        </>
      }
      sideContent={
        <SideNavigation
          onSelectionChange={onSelect}
          fixedItems={isAdmin ? (
            <SideNavigationItem text="Settings" icon="action-settings" data-to="/settings"
              selected={pathname === "/settings"} />
          ) : undefined}
        >
          <SideNavigationItem text="Home" icon="home" data-to="/" selected={pathname === "/"} />
              {isAdmin ? (
                <SideNavigationGroup text="SAP Business One" expanded>
                  {Object.values(B1_FEATURES).map((f) => (
                    <SideNavigationItem key={f.entity} text={f.label} icon={f.icon}
                      data-to={`/b1/${f.entity}`}
                      selected={pathname === `/b1/${f.entity}` || pathname.startsWith(`/b1/${f.entity}/`)} />
                  ))}
                </SideNavigationGroup>
              ) : null}
              <SideNavigationGroup text="Configurator" expanded>
                <SideNavigationItem
                  text="Configurations"
                  icon="sales-quote"
                  data-to="/configs"
                  selected={pathname === "/configs" || pathname.startsWith("/configs/")}
                />
                {isAdmin ? (
                  <>
                    <SideNavigationItem
                      text="Configurator models"
                      icon="tree"
                      data-to="/models"
                      selected={pathname === "/models" || pathname.startsWith("/models/")}
                    />
                    <SideNavigationItem
                      text="Master data"
                      icon="table-view"
                      data-to="/masterdata"
                      selected={pathname === "/masterdata" || pathname.startsWith("/masterdata/")}
                    />
                  </>
                ) : null}
              </SideNavigationGroup>
              {/* The customer portal (spec §10): Requests for every member, the rest for admins. */}
              <SideNavigationGroup text="Portal" expanded>
                <SideNavigationItem text="Requests" icon="inbox" data-to="/requests"
                  selected={pathname === "/requests"} />
                {isAdmin ? (
                  <SideNavigationItem text="Invitations" icon="paper-plane" data-to="/portal/invitations"
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
