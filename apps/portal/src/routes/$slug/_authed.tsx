import { createFileRoute, redirect } from "@tanstack/react-router";
import { meQuery } from "../../orpc.ts";
import { authUrl, hardRedirect, loginUrl } from "@confire/ui/host.ts";
import { PortalShell } from "../../components/PortalShell.tsx";

// Every signed-in page of a supplier's portal, for users with a seat there. The server re-checks
// every procedure regardless — this is UX, not the boundary.
export const Route = createFileRoute("/$slug/_authed")({
  beforeLoad: async ({ context, params }) => {
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
    if (!me.company) throw redirect({ to: "/$slug/onboarding", params });
  },
  component: PortalShell,
});
