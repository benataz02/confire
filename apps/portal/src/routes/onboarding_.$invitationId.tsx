import { useMemo } from "react";
import { createFileRoute, Navigate, redirect, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Avatar, Link, MessageStrip, ShellBar, ShellBarBranding } from "@ui5/webcomponents-react";
import { ObjectPage } from "@confire/ui/object-page/ObjectPage.tsx";
import { ObjectPageSkeleton } from "@confire/ui/object-page/ObjectPageSkeleton.tsx";
import { authClient } from "../auth-client.ts";
import { client, meQuery, orpc } from "../orpc.ts";
import { PortalAuthLayout } from "../components/AuthChrome.tsx";
import { authUrl, hardRedirect, loginUrl } from "../lib/host.ts";
import { invitationGuard } from "../lib/invitation.ts";
import { ONBOARDING_HEADER, ONBOARDING_LOCKED, onboardingSections } from "../features/onboarding.ts";

// The new-client form (spec §5.3): the BP-create ObjectPage, unchanged, over the section tree in
// features/onboarding.ts and the constraints `onboarding.formSchema` builds for this invitation. Not
// under `_authed` (no seat yet), so no side nav: the supplier's ShellBar and the form. Submit creates
// the lead in SAP and the seat; SAP's refusal comes back as the page's save error.
export const Route = createFileRoute("/onboarding_/$invitationId")({
  beforeLoad: async (ctx) => {
    const r = await invitationGuard(ctx);
    // Already in a company here: this form can only be refused, so home instead.
    if (r && "me" in r && r.me.company) throw redirect({ to: "/" });
    return r;
  },
  component: OnboardingForm,
});

function OnboardingForm() {
  const { invitationId } = Route.useParams();
  const { me } = Route.useRouteContext();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const inv = useQuery(orpc.onboarding.invitation.queryOptions({ input: { id: invitationId }, retry: false }));
  // Read once: a refetch would hand ObjectPage a new seed object, which resets the form.
  const schema = useQuery({
    ...orpc.onboarding.formSchema.queryOptions({ input: { id: invitationId } }),
    enabled: inv.data?.type === "new", retry: false, staleTime: Infinity, refetchOnWindowFocus: false,
  });
  const sections = useMemo(() => onboardingSections(schema.data?.extras ?? []), [schema.data]);
  const tenant = me.tenant.name;

  const switchAccount = async () => {
    await authClient.signOut();
    qc.clear();
    void hardRedirect(loginUrl());
  };

  if (inv.data?.type === "existing") return <Navigate to="/accept/$invitationId" params={{ invitationId }} replace />;
  const error = inv.error ?? schema.error;
  if (error) {
    return (
      <PortalAuthLayout tenant={me.tenant}>
        <h2 className="auth-h1">This invitation can't be used</h2>
        <MessageStrip design="Negative" hideCloseButton>{error.message}</MessageStrip>
        <p className="auth-sub">Ask your contact at {tenant} to send you a new invitation.</p>
        <p className="auth-alt">
          Signed in as {me.user.email}. <a href="#" onClick={(e) => { e.preventDefault(); void switchAccount(); }}>Use another account</a>
        </p>
      </PortalAuthLayout>
    );
  }

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <ShellBar
        branding={
          <ShellBarBranding logo={me.tenant.logo
            ? <img alt="" src={me.tenant.logo} />
            : <Avatar icon="building" size="XS" colorScheme="Accent6" accessibleName={tenant} />}>
            {tenant}
          </ShellBarBranding>
        }
      />
      <div style={{ flex: 1, minHeight: 0 }}>
        {!schema.data || !inv.data ? <ObjectPageSkeleton /> : (
          <ObjectPage
            isNew
            entity="BusinessPartners"
            constraints={schema.data}
            data={schema.data.seed}
            sections={sections}
            header={ONBOARDING_HEADER}
            lockedFields={ONBOARDING_LOCKED}
            localViews
            createLabel="Submit"
            notice={
              <MessageStrip design="Information" hideCloseButton>
                {inv.data.inviterName ? `${inv.data.inviterName} invited you` : "You're invited"} to {tenant}'s customer portal.
                Tell {tenant} about your company: once you submit, your account is ready and you are its owner on the portal.
                Signed in as {me.user.email}.{" "}
                <Link onClick={() => void switchAccount()}>Use another account</Link>
              </MessageStrip>
            }
            onSave={async (diff) => {
              await client.onboarding.submit({ id: invitationId, form: diff });
              // Reset, not invalidate: nothing observes `me` here, and _authed reads the cache.
              await qc.resetQueries({ queryKey: meQuery.queryKey });
              void navigate({ to: "/" });
            }}
            // Nowhere to go back to without a seat: the user's own places on the sign-in host.
            onCancelCreate={() => void hardRedirect(authUrl("/login"))}
          />
        )}
      </div>
    </div>
  );
}
