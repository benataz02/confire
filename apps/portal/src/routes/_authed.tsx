import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { sessionQuery } from "../auth-client.ts";
import { meQuery } from "../orpc.ts";
import { apexUrl, hardRedirect, isApex, loginUrl } from "../lib/host.ts";
import { PortalShell } from "../components/PortalShell.tsx";

// Every signed-in page. On the apex this is only the lobby (a session is enough, no supplier); on a
// supplier's host it is the shell, for users with a seat there. The server re-checks every procedure
// regardless — this is UX, not the boundary.
export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context }) => {
    if (isApex()) {
      const data = await context.queryClient.ensureQueryData(sessionQuery);
      if (!data?.session) throw redirect({ to: "/login" });
      return;
    }
    const me = await context.queryClient.ensureQueryData(meQuery).catch((e: unknown) => {
      const code = (e as { code?: string }).code;
      if (code === "UNAUTHORIZED") return "login" as const;
      if (code === "NOT_FOUND") return "lobby" as const; // no such supplier: back to the user's own list
      throw e;
    });
    if (me === "login") return hardRedirect(loginUrl());
    if (me === "lobby") return hardRedirect(apexUrl("/"));
    // No seat here, or the supplier's own staff: the page that says which, and what to do.
    if (me.internal || !me.company) throw redirect({ to: "/onboarding" });
  },
  component: () => (isApex() ? <Outlet /> : <PortalShell />),
});
