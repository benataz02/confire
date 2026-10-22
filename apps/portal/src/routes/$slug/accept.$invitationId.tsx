import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, MessageStrip } from "@ui5/webcomponents-react";
import { authClient } from "../../auth-client.ts";
import { ROLE_HELP_KEY, ROLE_KEY } from "../../features/labels.ts";
import { useI18n } from "../../i18n.ts";
import { meQuery, orpc } from "../../orpc.ts";
import { PortalAuthLayout } from "../../components/AuthChrome.tsx";
import { hardRedirect, loginUrl } from "@confire/ui/host.ts";
import { invitationGuard } from "../../lib/invitation.ts";

// The invitation link (spec §5.2): `portal.<domain>/<slug>/accept/<id>`. The server checks everything
// again on accept; this page only says what joining means, or why it can't. A new-client invitation
// goes on to its form (§5.3).
export const Route = createFileRoute("/$slug/accept/$invitationId")({
  beforeLoad: invitationGuard,
  component: Accept,
});

function Accept() {
  const { invitationId } = Route.useParams();
  const { me } = Route.useRouteContext();
  const qc = useQueryClient();
  const navigate = useNavigate({ from: "/$slug" });
  const inv = useQuery(orpc.onboarding.invitation.queryOptions({ input: { id: invitationId }, retry: false }));
  const accept = useMutation(orpc.onboarding.accept.mutationOptions({
    onSuccess: async () => {
      // Reset, not invalidate: nothing observes `me` here, so an invalidate refetches nothing and
      // _authed would read the seat-less `me` still in the cache.
      await qc.resetQueries({ queryKey: meQuery.queryKey });
      void navigate({ to: "/$slug" });
    },
  }));
  const tenant = me.tenant.name;
  const i18n = useI18n();

  // Signed in with the wrong address: out, and back to this link with another one.
  const switchAccount = async () => {
    await authClient.signOut();
    qc.clear();
    void hardRedirect(loginUrl());
  };
  const signedInAs = (
    <p className="auth-alt">
      {i18n.getText("PORTAL_SIGNED_IN_AS", me.user.email)}{" "}
      <a href="#" onClick={(e) => { e.preventDefault(); void switchAccount(); }}>{i18n.getText("PORTAL_OTHER_ACCOUNT")}</a>
    </p>
  );

  if (inv.isPending) {
    return <PortalAuthLayout tenant={me.tenant}><p className="auth-sub">{i18n.getText("PORTAL_INVITE_OPENING")}</p></PortalAuthLayout>;
  }

  if (inv.error) {
    return (
      <PortalAuthLayout tenant={me.tenant}>
        <h2 className="auth-h1">{i18n.getText("PORTAL_INVITE_UNUSABLE")}</h2>
        <MessageStrip design="Negative" hideCloseButton>{inv.error.message}</MessageStrip>
        {me.company ? (
          <Button design="Emphasized" onClick={() => void navigate({ to: "/$slug" })}>{i18n.getText("PORTAL_INVITE_GO_PORTAL", tenant)}</Button>
        ) : (
          <p className="auth-sub">{i18n.getText("PORTAL_INVITE_ASK_NEW", tenant)}</p>
        )}
        {signedInAs}
      </PortalAuthLayout>
    );
  }

  const d = inv.data;
  if (d.type === "new") return <Navigate from="/$slug" to="/$slug/onboarding/$invitationId" params={{ invitationId }} replace />;

  return (
    <PortalAuthLayout tenant={me.tenant}>
      <h2 className="auth-h1">{i18n.getText("PORTAL_JOIN", d.companyName ?? "")}</h2>
      <p className="auth-sub">
        {d.inviterName
          ? i18n.getText("PORTAL_ACCEPT_BODY_NAMED", d.inviterName, tenant, d.companyName ?? "", i18n.getText(ROLE_KEY[d.role]), i18n.getText(ROLE_HELP_KEY[d.role]))
          : i18n.getText("PORTAL_ACCEPT_BODY_ANON", tenant, d.companyName ?? "", i18n.getText(ROLE_KEY[d.role]), i18n.getText(ROLE_HELP_KEY[d.role]))}
      </p>
      {accept.error ? <MessageStrip design="Negative" hideCloseButton>{accept.error.message}</MessageStrip> : null}
      <Button design="Emphasized" disabled={accept.isPending} onClick={() => accept.mutate({ id: d.id })}>
        {accept.isPending ? i18n.getText("PORTAL_JOINING") : i18n.getText("PORTAL_ACCEPT_INVITATION")}
      </Button>
      {signedInAs}
    </PortalAuthLayout>
  );
}
