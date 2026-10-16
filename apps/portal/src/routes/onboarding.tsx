import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui5/webcomponents-react";
import { authClient } from "../auth-client.ts";
import { meQuery } from "../orpc.ts";
import { PortalAuthLayout } from "../components/AuthChrome.tsx";
import { apexUrl, authSearch, hardRedirect, isApex, loginUrl } from "../lib/host.ts";

// Signed in on a supplier's host without a seat there (spec §9). P3 adds auto-join by a registered
// email domain and invitation acceptance; until then this page says how to get in.
export const Route = createFileRoute("/onboarding")({
  beforeLoad: async ({ context }) => {
    if (isApex()) throw redirect({ to: "/" });
    const me = await context.queryClient.ensureQueryData(meQuery).catch((e: unknown) => {
      if ((e as { code?: string }).code === "UNAUTHORIZED") return null;
      throw e;
    });
    if (!me) return hardRedirect(loginUrl());
    if (me.company && !me.internal) throw redirect({ to: "/" });
    return { me };
  },
  component: Onboarding,
});

function Onboarding() {
  const { me } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const tenant = me.tenant.name;

  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    void hardRedirect(apexUrl(`/login${authSearch(undefined, me.tenant.slug)}`));
  };

  if (me.internal) {
    return (
      <PortalAuthLayout slug={me.tenant.slug}>
        <h2 className="auth-h1">You work for {tenant}</h2>
        <p className="auth-sub">
          This is {tenant}'s portal for its customers. Your account belongs to {tenant}'s own
          workspace, so open that instead.
        </p>
        <Button design="Emphasized" onClick={() => void hardRedirect(me.internalAppUrl!)}>
          Open {tenant}'s workspace
        </Button>
        <p className="auth-alt">
          Signed in as {me.user.email}. <a href="#" onClick={(e) => { e.preventDefault(); void signOut(); }}>Sign out</a>
        </p>
      </PortalAuthLayout>
    );
  }

  return (
    <PortalAuthLayout slug={me.tenant.slug}>
      <h2 className="auth-h1">Ask {tenant} for an invitation</h2>
      <p className="auth-sub">
        You're signed in as <strong>{me.user.email}</strong>, but that address isn't linked to a company
        on {tenant}'s portal yet. Ask your contact at {tenant} to invite you: the link in their email
        brings you straight in.
      </p>
      <p className="auth-alt">
        Used a different address with {tenant}? <a href="#" onClick={(e) => { e.preventDefault(); void signOut(); }}>Sign out</a> and
        sign in with that one.
      </p>
    </PortalAuthLayout>
  );
}
