import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BusyIndicator, MessageStrip } from "@ui5/webcomponents-react";
import { AuthCard, AuthChip, AuthHead, initials } from "@confire/ui/auth/AuthLayout.tsx";
import { authClient } from "../auth-client.ts";
import { ROLE_HELP_KEY, ROLE_KEY } from "../features/labels.ts";
import { useI18n } from "../i18n.ts";
import { meQuery, orpc } from "../orpc.ts";
import { InvitationUnusable, PortalAuthLayout, SignedInAs } from "../components/AuthChrome.tsx";
import { hardRedirect } from "@confire/ui/host.ts";
import { invitationGuard } from "../lib/guards.ts";

// The invitation link (spec §5.2): `portal.<domain>/<slug>/accept/<id>`. The server checks everything
// again on accept; this page only says what joining means, or why it can't. A new-client invitation
// goes on to its form (§5.3).
export const Route = createFileRoute("/$slug_/accept/$invitationId")({
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
      // $slug would read the seat-less `me` still in the cache.
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
    void hardRedirect(window.location.href);
  };

  if (inv.isPending) {
    return (
      <PortalAuthLayout tenant={me.tenant}>
        <AuthCard center>
          <BusyIndicator active />
          <p className="auth-note">{i18n.getText("PORTAL_INVITE_OPENING")}</p>
        </AuthCard>
      </PortalAuthLayout>
    );
  }

  if (inv.error) {
    return (
      <InvitationUnusable
        tenant={me.tenant} message={inv.error.message} email={me.user.email} onOtherAccount={() => void switchAccount()}
        goPortal={me.company ? () => void navigate({ to: "/$slug" }) : undefined}
      />
    );
  }

  const d = inv.data;
  if (d.type === "new") return <Navigate from="/$slug" to="/$slug/onboarding/$invitationId" params={{ invitationId }} replace />;
  const company = d.companyName ?? "";

  return (
    <PortalAuthLayout tenant={me.tenant}>
      <AuthHead
        title={i18n.getText("PORTAL_JOIN", company)}
        lead={d.inviterName ? i18n.getText("PORTAL_ACCEPT_LEAD_NAMED", d.inviterName, tenant) : i18n.getText("PORTAL_ACCEPT_LEAD_ANON", tenant)}
      />
      <AuthCard onSubmit={() => accept.mutate({ id: d.id })}>
        {accept.error ? <MessageStrip design="Negative" hideCloseButton>{accept.error.message}</MessageStrip> : null}
        <div className="auth-who">
          <span className="auth-avatar" aria-hidden="true">{initials(company)}</span>
          <b>{company}</b>
          <AuthChip tone="info">{i18n.getText(ROLE_KEY[d.role])}</AuthChip>
        </div>
        <p className="auth-note">{i18n.getText("PORTAL_ACCEPT_ROLE_NOTE", i18n.getText(ROLE_KEY[d.role]), i18n.getText(ROLE_HELP_KEY[d.role]))}</p>
        <button type="submit" className="auth-btn auth-btn--em" disabled={accept.isPending}>
          {accept.isPending ? i18n.getText("PORTAL_JOINING") : i18n.getText("PORTAL_ACCEPT_INVITATION")}
        </button>
      </AuthCard>
      <SignedInAs email={me.user.email} onOtherAccount={() => void switchAccount()} />
    </PortalAuthLayout>
  );
}
