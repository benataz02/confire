import { createFileRoute, redirect } from "@tanstack/react-router";
import { meQuery } from "../orpc.ts";
import { authUrl, currentSlug, hardRedirect, loginUrl } from "../lib/tenant.ts";
import { AppShell } from "../components/AppShell.tsx";

// The app shell for every signed-in page. The workspace is the path's first segment (the router's
// basepath); without one — the bare origin — this route never renders: the dispatcher (/login) decides.
export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    const slug = currentSlug();
    if (!slug) return hardRedirect(authUrl("/login"));

    // In a workspace: one call covers signed-in, member-of-this-workspace, and role.
    // beforeLoad re-runs on every navigation, so it's cached — an in-app route change costs
    // no network. Retry is off so a rejection bounces immediately.
    // The server re-checks membership on every procedure regardless — this is UX, not the boundary.
    const me = await context.queryClient
      .ensureQueryData({ ...meQuery, retry: false })
      .catch((e: unknown) => {
        const code = (e as { code?: string }).code;
        // Auth lives on the sign-in host. FORBIDDEN means this workspace isn't theirs (a customer
        // of it, say), so the dispatcher sends them to a place that is — it only ever picks a
        // workspace they are a member of, which is what keeps this from ping-ponging. Anything else
        // (a 500, a dead server) is a real failure: let it hit the error boundary rather than loop.
        if (code === "UNAUTHORIZED") return loginUrl();
        if (code === "FORBIDDEN") return authUrl("/login");
        throw e;
      });
    if (typeof me === "string") return hardRedirect(me);

    // Role decides which pages this shell renders. UX only — the server procedures are the boundary.
    const path = location.pathname;
    if (me.role !== "admin" && me.role !== "owner" && (path === "/settings" || path === "/b1" || path.startsWith("/b1/"))) {
      throw redirect({ to: "/" });
    }
  },
  component: AppShell,
});
