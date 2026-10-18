import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, MessageStrip } from "@ui5/webcomponents-react";
import { ROLE_HELP, ROLE_LABEL } from "@confire/ui/portal/CompanyPeople.tsx";
import { authClient } from "../auth-client.ts";
import { meQuery, orpc } from "../orpc.ts";
import { PortalAuthLayout } from "../components/AuthChrome.tsx";
import { hardRedirect, loginUrl } from "../lib/host.ts";
import { invitationGuard } from "../lib/invitation.ts";

// The invitation link (spec §5.2): `<slug>.portal.<domain>/accept/<id>`. The server checks everything
// again on accept; this page only says what joining means, or why it can't. A new-client invitation
// goes on to its form (§5.3).
export const Route = createFileRoute("/accept/$invitationId")({
  beforeLoad: invitationGuard,
  component: Accept,
});

function Accept() {
  const { invitationId } = Route.useParams();
  const { me } = Route.useRouteContext();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const inv = useQuery(orpc.onboarding.invitation.queryOptions({ input: { id: invitationId }, retry: false }));
  const accept = useMutation(orpc.onboarding.accept.mutationOptions({
    onSuccess: async () => {
      // Reset, not invalidate: nothing observes `me` here, so an invalidate refetches nothing and
      // _authed would read the seat-less `me` still in the cache.
      await qc.resetQueries({ queryKey: meQuery.queryKey });
      void navigate({ to: "/" });
    },
  }));
  const tenant = me.tenant.name;

  // Signed in with the wrong address: out, and back to this link with another one.
  const switchAccount = async () => {
    await authClient.signOut();
    qc.clear();
    void hardRedirect(loginUrl());
  };
  const signedInAs = (
    <p className="auth-alt">
      Signed in as {me.user.email}. <a href="#" onClick={(e) => { e.preventDefault(); void switchAccount(); }}>Use another account</a>
    </p>
  );

  if (inv.isPending) {
    return <PortalAuthLayout tenant={me.tenant}><p className="auth-sub">Opening your invitation…</p></PortalAuthLayout>;
  }

  if (inv.error) {
    return (
      <PortalAuthLayout tenant={me.tenant}>
        <h2 className="auth-h1">This invitation can't be used</h2>
        <MessageStrip design="Negative" hideCloseButton>{inv.error.message}</MessageStrip>
        {me.company ? (
          <Button design="Emphasized" onClick={() => void navigate({ to: "/" })}>Go to {tenant}'s portal</Button>
        ) : (
          <p className="auth-sub">Ask your contact at {tenant} to send you a new invitation.</p>
        )}
        {signedInAs}
      </PortalAuthLayout>
    );
  }

  const d = inv.data;
  if (d.type === "new") return <Navigate to="/onboarding/$invitationId" params={{ invitationId }} replace />;

  return (
    <PortalAuthLayout tenant={me.tenant}>
      <h2 className="auth-h1">Join {d.companyName}</h2>
      <p className="auth-sub">
        {d.inviterName ? `${d.inviterName} invited you` : "You're invited"} to {tenant}'s customer portal as
        part of <strong>{d.companyName}</strong>, with the role <strong>{ROLE_LABEL[d.role]}</strong>: {ROLE_HELP[d.role].toLowerCase()}.
      </p>
      {accept.error ? <MessageStrip design="Negative" hideCloseButton>{accept.error.message}</MessageStrip> : null}
      <Button design="Emphasized" disabled={accept.isPending} onClick={() => accept.mutate({ id: d.id })}>
        {accept.isPending ? "Joining…" : "Accept invitation"}
      </Button>
      {signedInAs}
    </PortalAuthLayout>
  );
}
