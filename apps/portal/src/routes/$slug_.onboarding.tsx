import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { authClient } from "../auth-client.ts";
import { client, meQuery } from "../orpc.ts";
import { AuthCard, AuthHead, AuthTile } from "@confire/ui/auth/AuthLayout.tsx";
import { PortalAuthLayout } from "../components/AuthChrome.tsx";
import { useI18n } from "../i18n.ts";
import { hardRedirect, loginUrl } from "@confire/ui/host.ts";
import { portalMe } from "../lib/guards.ts";

// Signed in on a supplier's portal without a seat there (spec §4.4, §9). First auto-join: a verified
// address on a domain the supplier registered to a company joins it as viewer, and lands home. If
// nothing matches, this is the invite-only page: it grants nothing, and never offers workspace setup.
// An invitation's link (/accept/<id>) is the other way in.
export const Route = createFileRoute("/$slug_/onboarding")({
  beforeLoad: async ({ context, params }) => {
    const me = await portalMe(context.queryClient, params.slug);
    if (me.company) throw redirect({ to: "/$slug", params });
    // A failed join is the same as no match: the page below still says how to get in.
    if (await client.onboarding.join().catch(() => null)) {
      // Reset, not invalidate: an unobserved query is not refetched, and $slug reads the cache.
      await context.queryClient.resetQueries({ queryKey: meQuery.queryKey });
      throw redirect({ to: "/$slug", params });
    }
    return { me };
  },
  component: Onboarding,
});

function Onboarding() {
  const { me } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const tenant = me.tenant.name;
  const i18n = useI18n();

  // Out, and back here signed in with the other address.
  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    void hardRedirect(loginUrl());
  };

  return (
    <PortalAuthLayout tenant={me.tenant}>
      <AuthHead title={i18n.getText("PORTAL_ONBOARD_ASK", tenant)} />
      <AuthCard center>
        <AuthTile icon="locked" tone="ai" />
        <p className="auth-body">{i18n.getText("PORTAL_ONBOARD_BODY", tenant, me.user.email)}</p>
        <p className="auth-note">
          {i18n.getText("PORTAL_ONBOARD_OTHER", tenant)}{" "}
          <a href="#" onClick={(e) => { e.preventDefault(); void signOut(); }}>{i18n.getText("PORTAL_SIGN_OUT")}</a>
          {" "}{i18n.getText("PORTAL_ONBOARD_THEN")}
        </p>
      </AuthCard>
    </PortalAuthLayout>
  );
}
