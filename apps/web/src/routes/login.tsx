import { createFileRoute, redirect, useRouter, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Input, Button, MessageStrip, List, ListItemStandard } from "@ui5/webcomponents-react";
import { ROLE_LABEL } from "@confire/ui/portal/CompanyPeople.tsx";
import { authClient, sessionQuery } from "../auth-client.ts";
import { lobbyQuery } from "../orpc.ts";
import { AuthLayout } from "../components/AuthLayout.tsx";
import { SocialButtons } from "../components/SocialButtons.tsx";
import { authUrl, hardRedirect, isAuthHost, safeRedirect } from "../lib/tenant.ts";
import { authErrorMessage, notVerifiedMessage } from "@confire/ui/auth/messages.ts";

type Place = { url: string; title: string; description: string; icon: string; role?: string };

// The one sign-in for staff and customers, and the dispatcher (spec 2026-10-17-single-sign-in-design.md
// §5.1). Signed out it is the form. Signed in it sends the user on: to `redirect` (the page a 401
// bounced from — that app's own guard decides from there, which is how a portal stays invite-only),
// else to their one place, else it renders "Where to?". No place at all is workspace setup.
// ?error=<code> (social sign-in, a dead verification link) reads through authErrorMessage.
export const Route = createFileRoute("/login")({
  validateSearch: (s: Record<string, unknown>): { redirect?: string; error?: string } => ({
    redirect: typeof s.redirect === "string" ? s.redirect : undefined,
    error: typeof s.error === "string" ? s.error : undefined,
  }),
  beforeLoad: async ({ context, search, location }) => {
    if (!isAuthHost()) return hardRedirect(authUrl(`/login${location.searchStr}`));
    const data = await context.queryClient.ensureQueryData(sessionQuery);
    if (!data?.session) return { places: null };
    const to = safeRedirect(search.redirect);
    if (to) return hardRedirect(to);
    const { workspace, portals } = await context.queryClient.fetchQuery(lobbyQuery);
    if (!workspace && !portals.length) throw redirect({ to: "/onboarding" });
    if (workspace?.needsAgent) throw redirect({ to: "/onboarding" });
    const places: Place[] = [
      ...(workspace ? [{ url: workspace.url, title: workspace.name, description: "Your workspace", icon: "building" }] : []),
      ...portals.map((p) => ({ url: p.url, title: p.tenantName, description: `${p.cardName} · customer portal`, icon: "supplier", role: ROLE_LABEL[p.role] })),
    ];
    if (places.length === 1) return hardRedirect(places[0]!.url);
    return { places };
  },
  component: Login,
});

function Login() {
  const { places } = Route.useRouteContext();
  return places ? <WhereTo places={places} /> : <SignIn />;
}

function SignIn() {
  const router = useRouter();
  const { redirect: redirectTo, error: oauthError } = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const queryClient = useQueryClient();

  const signIn = useMutation({
    // Deliberately unconditional: an existing session must NOT short-circuit this. Another tab
    // can sign in as someone else while this page sits open, and returning that session would
    // hand these credentials the wrong workspace. Better Auth replaces the session cookie.
    mutationFn: async (vars: { email: string; password: string }) => {
      const res = await authClient.signIn.email(vars);
      // Unverified: Better Auth has just mailed a fresh link (sendOnSignIn), so say where it went.
      if (res.error?.code === "EMAIL_NOT_VERIFIED") throw new Error(notVerifiedMessage(vars.email));
      if (res.error) throw new Error(res.error.message ?? "Sign in failed");
      return res.data;
    },
    onSuccess: async () => {
      // staleTime:0 is load-bearing: a cached `null` counts as a cache hit, so ensureQueryData
      // would never refetch after sign-in. Then re-run beforeLoad: signed in, it dispatches.
      await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
      await router.invalidate();
    },
  });

  const submit = () => email && password && signIn.mutate({ email, password });
  const error = signIn.error?.message ?? (oauthError ? authErrorMessage(oauthError) : null);

  return (
    <AuthLayout>
      <h2 className="auth-h1">Welcome back</h2>
      <p className="auth-sub">Sign in to Confire.</p>
      {error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : null}
      <label className="auth-field">
        <span>Email</span>
        <Input type="Email" value={email} onInput={(e) => setEmail(e.target.value)} />
      </label>
      <label className="auth-field">
        <span>Password</span>
        <Input
          type="Password"
          value={password}
          onInput={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </label>
      <Button design="Emphasized" disabled={signIn.isPending} onClick={submit}>
        {signIn.isPending ? "Signing in…" : "Sign in"}
      </Button>
      <p className="auth-alt"><Link to="/forgot-password">Forgot your password?</Link></p>
      <div className="auth-or">or</div>
      <SocialButtons redirect={redirectTo} />
      <p className="auth-alt">
        New to Confire? <Link to="/signup" search={{ redirect: redirectTo }}>Create an account</Link>
      </p>
    </AuthLayout>
  );
}

/** More than one place (spec S6): the workspace first, then each supplier portal. */
function WhereTo({ places }: { places: Place[] }) {
  const queryClient = useQueryClient();
  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    window.location.assign("/login");
  };
  return (
    <AuthLayout>
      <h2 className="auth-h1">Where to?</h2>
      <List
        onItemClick={(e) => {
          const url = (e.detail.item as HTMLElement).dataset.url;
          if (url) void hardRedirect(url);
        }}
      >
        {places.map((p) => (
          <ListItemStandard key={p.url} data-url={p.url} icon={p.icon} description={p.description} additionalText={p.role}>
            {p.title}
          </ListItemStandard>
        ))}
      </List>
      <p className="auth-alt">
        <a href="/login" onClick={(e) => { e.preventDefault(); void signOut(); }}>Sign out</a>
      </p>
    </AuthLayout>
  );
}
