import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { authClient } from "../auth-client.ts";
import { client, meQuery } from "../orpc.ts";
import { PortalAuthLayout } from "../components/AuthChrome.tsx";
import { authUrl, hardRedirect, isApex, loginUrl } from "../lib/host.ts";

// Signed in on a supplier's host without a seat there (spec §4.4, §9). First auto-join: a verified
// address on a domain the supplier registered to a company joins it as viewer, and lands home. If
// nothing matches, this is the invite-only page: it grants nothing, and never offers workspace setup.
// An invitation's link (/accept/<id>) is the other way in.
export const Route = createFileRoute("/onboarding")({
  beforeLoad: async ({ context }) => {
    if (isApex()) return hardRedirect(authUrl("/login"));
    const me = await context.queryClient.ensureQueryData(meQuery).catch((e: unknown) => {
      if ((e as { code?: string }).code === "UNAUTHORIZED") return null;
      throw e;
    });
    if (!me) return hardRedirect(loginUrl());
    if (me.internal) return hardRedirect(me.internalAppUrl!);
    if (me.company) throw redirect({ to: "/" });
    // A failed join is the same as no match: the page below still says how to get in.
    if (await client.onboarding.join().catch(() => null)) {
      // Reset, not invalidate: an unobserved query is not refetched, and _authed reads the cache.
      await context.queryClient.resetQueries({ queryKey: meQuery.queryKey });
      throw redirect({ to: "/" });
    }
    return { me };
  },
  component: Onboarding,
});

function Onboarding() {
  const { me } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const tenant = me.tenant.name;

  // Out, and back here signed in with the other address.
  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    void hardRedirect(loginUrl());
  };

  return (
    <PortalAuthLayout tenant={me.tenant}>
      <h2 className="auth-h1">Ask {tenant} for an invitation</h2>
      <p className="auth-sub">
        {tenant}'s portal is by invitation only. You're signed in as <strong>{me.user.email}</strong>, but
        that address isn't linked to a company on it yet. Ask your contact at {tenant} to invite you: the
        link in their email brings you straight in.
      </p>
      <p className="auth-alt">
        Used a different address with {tenant}? <a href="#" onClick={(e) => { e.preventDefault(); void signOut(); }}>Sign out</a> and
        sign in with that one.
      </p>
    </PortalAuthLayout>
  );
}
