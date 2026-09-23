import { createFileRoute, redirect } from "@tanstack/react-router";
import { authClient, sessionQuery } from "../auth-client.ts";
import { meQuery, sapGate } from "../orpc.ts";
import { apexUrl, currentSlug, hardRedirect, tenantUrl } from "../lib/tenant.ts";
import { AppShell } from "../components/AppShell.tsx";

// The app shell for every signed-in page. The tenant is the subdomain; on the apex this
// route is just the lobby dispatcher (it never renders the app there).
export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    const slug = currentSlug();

    if (!slug) {
      // Apex lobby: no tenant to resolve, so this is the one branch that reads the session
      // directly. A user belongs to exactly one company, so there is nothing to pick:
      // it's their workspace, or onboarding to create/join one.
      const data = await context.queryClient.ensureQueryData(sessionQuery);
      if (!data?.session) throw redirect({ to: "/login" });
      // Deliberately uncached: accept.tsx reaches this dispatcher via a client-side navigate
      // right after joining an org, and a cached list would miss the new membership.
      const orgs = (await authClient.organization.list()).data ?? [];
      const org = orgs[0];
      if (!org) throw redirect({ to: "/onboarding" });
      const gate = await sapGate(context.queryClient);
      if (gate === "setup") throw redirect({ to: "/onboarding" });
      return hardRedirect(tenantUrl(org.slug));
    }

    // Tenant subdomain: one call covers signed-in, member-of-this-workspace, and role.
    // beforeLoad re-runs on every navigation, so it's cached — an in-app route change costs
    // no network. Retry is off so a rejection bounces immediately.
    // The server re-checks membership on every procedure regardless — this is UX, not the boundary.
    const me = await context.queryClient
      .ensureQueryData({ ...meQuery, retry: false })
      .catch((e: unknown) => {
        const code = (e as { code?: string }).code;
        // Auth lives on the apex. FORBIDDEN means this workspace isn't theirs, so the apex
        // dispatcher sends them to the one that is — it can only ever pick a *different*
        // slug, which is what keeps this from ping-ponging. Anything else (a 500, a dead
        // server) is a real failure: let it hit the error boundary rather than loop.
        if (code === "UNAUTHORIZED") return "/login";
        if (code === "FORBIDDEN") return "/";
        throw e;
      });
    if (typeof me === "string") return hardRedirect(apexUrl(me));

    // Role decides which app this shell renders. UX only — the server procedures are the boundary.
    const path = location.pathname;
    if (me.role === "client" && !path.startsWith("/portal")) throw redirect({ to: "/portal" });
    if (me.role !== "client" && path.startsWith("/portal")) throw redirect({ to: "/" });
    if (me.role !== "admin" && me.role !== "owner" && (path === "/b1" || path.startsWith("/b1/"))) {
      throw redirect({ to: "/" });
    }
  },
  component: AppShell,
});
