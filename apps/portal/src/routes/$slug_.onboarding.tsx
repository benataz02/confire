import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { authClient } from "../../auth-client.ts";
import { client, meQuery } from "../../orpc.ts";
import { PortalAuthLayout } from "../../components/AuthChrome.tsx";
import { useI18n } from "../../i18n.ts";
import { hardRedirect, loginUrl } from "@confire/ui/host.ts";

// Signed in on a supplier's portal without a seat there (spec §4.4, §9). First auto-join: a verified
// address on a domain the supplier registered to a company joins it as viewer, and lands home. If
// nothing matches, this is the invite-only page: it grants nothing, and never offers workspace setup.
// An invitation's link (/accept/<id>) is the other way in.
export const Route = createFileRoute("/$slug/onboarding")({
  beforeLoad: async ({ context, params }) => {
    const me = await context.queryClient.ensureQueryData(meQuery).catch((e: unknown) => {
      if ((e as { code?: string }).code === "UNAUTHORIZED") return null;
      throw e;
    });
    if (!me) return hardRedirect(loginUrl());
    if (me.internal) return hardRedirect(me.internalAppUrl!);
    if (me.company) throw redirect({ to: "/$slug", params });
    // A failed join is the same as no match: the page below still says how to get in.
    if (await client.onboarding.join().catch(() => null)) {
      // Reset, not invalidate: an unobserved query is not refetched, and _authed reads the cache.
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
      <h2 className="auth-h1">{i18n.getText("PORTAL_ONBOARD_ASK", tenant)}</h2>
      <p className="auth-sub">{i18n.getText("PORTAL_ONBOARD_BODY", tenant, me.user.email)}</p>
      <p className="auth-alt">
        {i18n.getText("PORTAL_ONBOARD_OTHER", tenant)}{" "}
        <a href="#" onClick={(e) => { e.preventDefault(); void signOut(); }}>{i18n.getText("PORTAL_SIGN_OUT")}</a>
        {" "}{i18n.getText("PORTAL_ONBOARD_THEN")}
      </p>
    </PortalAuthLayout>
  );
}
