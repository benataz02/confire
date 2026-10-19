import { createFileRoute, redirect } from "@tanstack/react-router";
import { meQuery } from "../orpc.ts";
import { authUrl, currentSlug, hardRedirect, loginUrl } from "../lib/host.ts";
import { PortalShell } from "../components/PortalShell.tsx";

// Every signed-in page, under a supplier's path segment, for users with a seat there. The bare portal
// origin has nothing of its own: the dispatcher on the sign-in host decides where a user goes. The
// server re-checks every procedure regardless — this is UX, not the boundary.
export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context }) => {
    if (!currentSlug()) return hardRedirect(authUrl("/login"));
    const me = await context.queryClient.ensureQueryData(meQuery).catch((e: unknown) => {
      const code = (e as { code?: string }).code;
      if (code === "UNAUTHORIZED") return loginUrl();
      if (code === "NOT_FOUND") return authUrl("/login"); // no such supplier: the user's own places
      throw e;
    });
    if (typeof me === "string") return hardRedirect(me);
    // The supplier's own staff belong in its workspace (staff and customer are exclusive, spec D3).
    if (me.internal) return hardRedirect(me.internalAppUrl!);
    // No seat here: auto-join, or the invite-only page.
    if (!me.company) throw redirect({ to: "/onboarding" });
  },
  component: PortalShell,
});
