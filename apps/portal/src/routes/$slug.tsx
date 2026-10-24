import { createFileRoute, redirect } from "@tanstack/react-router";
import { portalMe } from "../lib/guards.ts";
import { PortalShell } from "../components/PortalShell.tsx";

// One supplier's portal, `/<slug>/…`, and the shell for every page that needs a seat there. The pages
// before a seat (an invitation, onboarding) are `$slug_.*`: same URLs, not nested, so neither this
// guard nor the shell runs for them. A link carries `slug` over from the current params and never
// changes it: another supplier is always a hardRedirect.
export const Route = createFileRoute("/$slug")({
  beforeLoad: async ({ context, params }) => {
    const me = await portalMe(context.queryClient, params.slug);
    // No seat here: auto-join, or the invite-only page.
    if (!me.company) throw redirect({ to: "/$slug/onboarding", params });
  },
  component: PortalShell,
});
