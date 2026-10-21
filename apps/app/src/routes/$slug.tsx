import { createFileRoute, redirect } from "@tanstack/react-router";
import { meQuery } from "../orpc.ts";
import { authUrl, hardRedirect, isSlug, loginUrl } from "@confire/ui/host.ts";
import { AppShell } from "../components/AppShell.tsx";

// The workspace `/<slug>/…`, and the app shell for every signed-in page. The sign-in pages are static
// routes, which outrank this one; the bare origin is `index.tsx`. A link carries `slug` over from the
// current params and never changes it: another workspace is always a hardRedirect.
export const Route = createFileRoute("/$slug")({
  beforeLoad: async ({ context, params }) => {
    // A reserved name is never a workspace (and the oRPC link sends no x-tenant for one).
    if (!isSlug(params.slug)) throw redirect({ to: "/login" });

    // One call covers signed-in, member-of-this-workspace, and role.
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
    return { me };
  },
  component: AppShell,
});
