import { createFileRoute, Navigate, redirect, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Avatar, Link, MessageStrip, ShellBar, ShellBarBranding } from "@ui5/webcomponents-react";
import { ObjectPage } from "@confire/ui/object-page/ObjectPage.tsx";
import { ObjectPageSkeleton } from "@confire/ui/object-page/ObjectPageSkeleton.tsx";
import { authClient } from "../auth-client.ts";
import { client, meQuery, orpc } from "../orpc.ts";
import { InvitationUnusable } from "../components/AuthChrome.tsx";
import { authUrl, hardRedirect } from "@confire/ui/host.ts";
import { invitationGuard } from "../lib/guards.ts";
import { useI18n } from "../i18n.ts";
import { ONBOARDING_HEADER, ONBOARDING_LOCKED, onboardingSections } from "../features/onboarding.ts";

// The new-client form (spec §5.3): the BP-create ObjectPage, unchanged, over the section tree in
// features/onboarding.ts and the constraints `onboarding.formSchema` builds for this invitation. Not
// nested under `$slug` (no seat yet), so no side nav: the supplier's ShellBar and the form. Submit creates
// the lead in SAP and the seat; SAP's refusal comes back as the page's save error.
export const Route = createFileRoute("/$slug_/onboarding_/$invitationId")({
  beforeLoad: async (ctx) => {
    const r = await invitationGuard(ctx);
    // Already in a company here: this form can only be refused, so home instead.
    if (r.me.company) throw redirect({ to: "/$slug", params: ctx.params });
    return r;
  },
  component: OnboardingForm,
});

function OnboardingForm() {
  const { invitationId } = Route.useParams();
  const { me } = Route.useRouteContext();
  const qc = useQueryClient();
  const navigate = useNavigate({ from: "/$slug" });
  const inv = useQuery(orpc.onboarding.invitation.queryOptions({ input: { id: invitationId }, retry: false }));
  // Read once: a refetch would hand ObjectPage a new seed object, which resets the form.
  const schema = useQuery({
    ...orpc.onboarding.formSchema.queryOptions({ input: { id: invitationId } }),
    enabled: inv.data?.type === "new", retry: false, staleTime: Infinity, refetchOnWindowFocus: false,
  });
  const i18n = useI18n();
  const sections = onboardingSections(schema.data?.extras ?? [], i18n.getText.bind(i18n));
  const tenant = me.tenant.name;

  const switchAccount = async () => {
    await authClient.signOut();
    qc.clear();
    // This link again, signed out: the guard sends it to sign-up or sign-in for the invited address.
    void hardRedirect(window.location.href);
  };

  if (inv.data?.type === "existing") return <Navigate from="/$slug" to="/$slug/accept/$invitationId" params={{ invitationId }} replace />;
  const error = inv.error ?? schema.error;
  if (error) {
    return <InvitationUnusable tenant={me.tenant} message={error.message} email={me.user.email} onOtherAccount={() => void switchAccount()} />;
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
            header={{ ...ONBOARDING_HEADER, createTitle: i18n.getText("PORTAL_YOUR_COMPANY") }}
            lockedFields={ONBOARDING_LOCKED}
            localViews
            createLabel={i18n.getText("PORTAL_SUBMIT")}
            notice={
              <MessageStrip design="Information" hideCloseButton>
                {inv.data.inviterName
                  ? i18n.getText("PORTAL_ONBOARD_NOTICE_NAMED", inv.data.inviterName, tenant)
                  : i18n.getText("PORTAL_ONBOARD_NOTICE_ANON", tenant)}
                {" "}
                {i18n.getText("PORTAL_SIGNED_IN_AS", me.user.email)}{" "}
                <Link onClick={() => void switchAccount()}>{i18n.getText("PORTAL_OTHER_ACCOUNT")}</Link>
              </MessageStrip>
            }
            onSave={async (diff) => {
              await client.onboarding.submit({ id: invitationId, form: diff });
              // Reset, not invalidate: nothing observes `me` here, and $slug reads the cache.
              await qc.resetQueries({ queryKey: meQuery.queryKey });
              void navigate({ to: "/$slug" });
            }}
            // Nowhere to go back to without a seat: the user's own places on the sign-in host.
            onLeave={() => void hardRedirect(authUrl("/login"))}
          />
        )}
      </div>
    </div>
  );
}
