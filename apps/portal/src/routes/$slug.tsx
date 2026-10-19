import { createFileRoute } from "@tanstack/react-router";
import { authUrl, hardRedirect, isSlug } from "@confire/ui/host.ts";

// One supplier's portal, `/<slug>/…`: every portal page is one supplier's. A link carries `slug` over
// from the current params and never changes it: another supplier is always a hardRedirect.
export const Route = createFileRoute("/$slug")({
  beforeLoad: ({ params }) => {
    // A reserved name is never a supplier (and the oRPC link sends no x-tenant for one).
    if (!isSlug(params.slug)) return hardRedirect(authUrl("/login"));
  },
});
