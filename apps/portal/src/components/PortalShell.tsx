import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Avatar, Button, NavigationLayout, ShellBar, ShellBarBranding, SideNavigation, SideNavigationGroup, SideNavigationItem,
  UserMenu, UserMenuAccount, UserMenuItem,
} from "@ui5/webcomponents-react";
import type { NavigationLayoutDomRef, NavigationLayoutPropTypes, SideNavigationPropTypes } from "@ui5/webcomponents-react";
import { THEMES, useAppearance } from "@confire/ui/appearance.ts";
import { ROLE_LABEL } from "@confire/ui/portal/CompanyPeople.tsx";
import { authClient } from "../auth-client.ts";
import { lobbyQuery, meQuery, type Me } from "../orpc.ts";
import { authUrl, hardRedirect, tenantPath } from "@confire/ui/host.ts";
import { useEntityNav } from "@confire/ui/EntityLink.tsx";
import { DOC_PAGES } from "../features/documents.ts";

// The supplier's portal chrome (spec §9): the same NavigationLayout + ShellBar + SideNavigation
// pattern as the internal AppShell, wearing the supplier's name and logo (D20). Fiori: no shell-bar
// Back button (the browser's does that), the branding element leads home, the profile opens the
// user menu.

export const roleLabel = (role: keyof typeof ROLE_LABEL) => ROLE_LABEL[role];

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

/** The supplier's accent (D20) as Horizon's own variables, so the shell bar and every emphasized
 *  button follow it. Save refused an accent white text can't be read on (4.5:1). */
const accentVars = (accent: string): Record<string, string> => {
  const darker = (pct: number) => `color-mix(in srgb, ${accent} ${pct}%, #000)`;
  return {
    "--sapShellColor": accent,
    "--sapShell_TextColor": "#fff",
    "--sapShell_InteractiveTextColor": "#fff",
    // The branding title: Horizon draws the sub-brand in its own blue.
    "--sapShell_SubBrand_TextColor": "#fff",
    "--sapShell_Active_TextColor": "#fff",
    "--sapShell_Hover_Background": "color-mix(in srgb, #fff 15%, transparent)",
    "--sapShell_Active_Background": "color-mix(in srgb, #fff 25%, transparent)",
    "--sapButton_Emphasized_Background": accent,
    "--sapButton_Emphasized_BorderColor": accent,
    "--sapButton_Emphasized_TextColor": "#fff",
    "--sapButton_Emphasized_Hover_Background": darker(85),
    "--sapButton_Emphasized_Hover_BorderColor": darker(85),
    "--sapButton_Emphasized_Hover_TextColor": "#fff",
    "--sapButton_Emphasized_Active_Background": darker(75),
    "--sapButton_Emphasized_Active_BorderColor": darker(75),
    "--sapButton_Emphasized_Active_TextColor": "#fff",
  };
};

export function PortalShell() {
  const go = useEntityNav();
  const queryClient = useQueryClient();
  // Inside the supplier's portal, as the nav items name it.
  const pathname = useRouterState({ select: (s) => tenantPath(s.location.pathname) });
  // Primed by _authed's beforeLoad, which only renders the shell for a user with a seat.
  const me = useQuery(meQuery).data as Me & { company: NonNullable<Me["company"]> };
  // Switching supplier only means something with more than one.
  const lobby = useQuery(lobbyQuery);
  const { theme, setTheme, density, setDensity } = useAppearance();
  // On the document, inline: it outranks the theme's :root parameters, in every theme.
  useEffect(() => {
    if (!me.tenant.accent) return;
    const vars = accentVars(me.tenant.accent);
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
    return () => { for (const k of Object.keys(vars)) root.removeProperty(k); };
  }, [me.tenant.accent]);
  const [menuOpen, setMenuOpen] = useState(false);
  const layout = useRef<NavigationLayoutDomRef>(null);
  const [navMode, setNavMode] = useState<NavigationLayoutPropTypes["mode"]>("Auto");
  const toggleNav = () => setNavMode(layout.current?.isSideCollapsed() ? "Expanded" : "Collapsed");
  // As in AppShell: touching the content collapses the nav; the chrome is excluded by host tag.
  const collapseOnContentClick = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("ui5-side-navigation, ui5-shellbar, ui5-user-menu")) return;
    if (!layout.current?.isSideCollapsed()) setNavMode("Collapsed");
  };

  const onSelect: SideNavigationPropTypes["onSelectionChange"] = (e) => {
    const to = (e.detail.item as HTMLElement).dataset.to;
    if (to) go(to);
  };

  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    void hardRedirect(authUrl("/login"));
  };

  return (
    <NavigationLayout
      ref={layout}
      mode={navMode}
      onClick={collapseOnContentClick}
      header={
        <>
          <ShellBar
            startButton={<Button icon="menu" tooltip="Menu" onClick={toggleNav} />}
            branding={
              <ShellBarBranding
                logo={me.tenant.logo
                  ? <img alt="" src={me.tenant.logo} />
                  : <Avatar icon="building" size="XS" colorScheme="Accent6" accessibleName={me.tenant.name} />}
                onClick={() => go("/")}
              >
                {me.tenant.name}
              </ShellBarBranding>
            }
            profile={<Avatar id="portal-user-menu" initials={initials(me.user.name)} />}
            onProfileClick={() => setMenuOpen((open) => !open)}
          />
          <UserMenu
            open={menuOpen}
            opener="portal-user-menu"
            onClose={() => setMenuOpen(false)}
            onSignOutClick={() => void signOut()}
            accounts={
              <UserMenuAccount
                avatarInitials={initials(me.user.name)}
                titleText={me.user.name}
                subtitleText={me.user.email}
                description={`${me.company.cardName} · ${roleLabel(me.company.role)}`}
              />
            }
          >
            <UserMenuItem text="Theme" icon="palette">
              {THEMES.map((t) => (
                <UserMenuItem key={t.id} text={t.label} icon={theme === t.id ? "sys-enter" : ""} onClick={() => setTheme(t.id)} />
              ))}
            </UserMenuItem>
            <UserMenuItem text="Density" icon="resize-horizontal">
              <UserMenuItem text="Compact" icon={density === "compact" ? "sys-enter" : ""} onClick={() => setDensity("compact")} />
              <UserMenuItem text="Cozy" icon={density === "cozy" ? "sys-enter" : ""} onClick={() => setDensity("cozy")} />
            </UserMenuItem>
            {(lobby.data?.length ?? 0) > 1 ? (
              <UserMenuItem text="Switch supplier" icon="switch-views" onClick={() => void hardRedirect(authUrl("/login?choose=1"))} />
            ) : null}
          </UserMenu>
        </>
      }
      sideContent={
        <SideNavigation
          onSelectionChange={onSelect}
          fixedItems={me.company.role === "owner" ? (
            <SideNavigationItem text="Company" icon="building" data-to="/company" selected={pathname === "/company"} />
          ) : undefined}
        >
          <SideNavigationItem text="Home" icon="home" data-to="/" selected={pathname === "/"} />
          <SideNavigationItem text="Projects" icon="product" data-to="/projects"
            selected={pathname === "/projects" || pathname.startsWith("/projects/")} />
          <SideNavigationGroup text="Documents" expanded>
            {Object.entries(DOC_PAGES).map(([entity, p]) => (
              <SideNavigationItem key={entity} text={p.label} icon={p.icon} data-to={`/docs/${entity}`}
                selected={pathname === `/docs/${entity}` || pathname.startsWith(`/docs/${entity}/`)} />
            ))}
          </SideNavigationGroup>
        </SideNavigation>
      }
    >
      <Outlet />
    </NavigationLayout>
  );
}
