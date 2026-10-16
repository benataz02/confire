import { useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Avatar, Button, NavigationLayout, ShellBar, ShellBarBranding, SideNavigation, SideNavigationItem,
  UserMenu, UserMenuAccount, UserMenuItem,
} from "@ui5/webcomponents-react";
import type { NavigationLayoutDomRef, NavigationLayoutPropTypes, SideNavigationPropTypes } from "@ui5/webcomponents-react";
import { THEMES, useAppearance } from "@confire/ui/appearance.ts";
import { authClient } from "../auth-client.ts";
import { lobbyQuery, meQuery, type Me } from "../orpc.ts";
import { apexUrl, authSearch, hardRedirect } from "../lib/host.ts";

// The supplier's portal chrome (spec §9): the same NavigationLayout + ShellBar + SideNavigation
// pattern as the internal AppShell, wearing the supplier's name and logo (D20). Fiori: no shell-bar
// Back button (the browser's does that), the branding element leads home, the profile opens the
// user menu. P3+ add the side-nav items (Projects, Documents, Company) as their pages land.

export const roleLabel = (role: "owner" | "buyer" | "viewer") =>
  role === "owner" ? "Owner" : role === "buyer" ? "Buyer" : "Viewer";

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

export function PortalShell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Primed by _authed's beforeLoad, which only renders the shell for a user with a seat.
  const me = useQuery(meQuery).data as Me & { company: NonNullable<Me["company"]> };
  // Switching supplier only means something with more than one.
  const lobby = useQuery(lobbyQuery);
  const { theme, setTheme, density, setDensity } = useAppearance();
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
    if (to) void navigate({ to });
  };

  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    void hardRedirect(apexUrl(`/login${authSearch(undefined, me.tenant.slug)}`));
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
                onClick={() => void navigate({ to: "/" })}
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
              <UserMenuItem text="Switch supplier" icon="switch-views" onClick={() => void hardRedirect(apexUrl("/"))} />
            ) : null}
          </UserMenu>
        </>
      }
      sideContent={
        <SideNavigation onSelectionChange={onSelect}>
          <SideNavigationItem text="Home" icon="home" data-to="/" selected={pathname === "/"} />
        </SideNavigation>
      }
    >
      <Outlet />
    </NavigationLayout>
  );
}
