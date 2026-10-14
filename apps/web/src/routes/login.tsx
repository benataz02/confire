import { createFileRoute, redirect, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Input, Button, MessageStrip } from "@ui5/webcomponents-react";
import { authClient, sessionQuery } from "../auth-client.ts";
import { AuthLayout } from "../components/AuthLayout.tsx";
import { SocialButtons } from "../components/SocialButtons.tsx";
import { apexUrl, hardRedirect, isApex, safeRedirect } from "../lib/tenant.ts";

// Social sign-in failures come back as ?error=<code> (SocialButtons' errorCallbackURL).
// account_not_linked is the one people hit: a password account already owns the email, and
// Better Auth won't attach a provider to an unverified one — which is every password account
// until a mailer exists. Don't "fix" that: it's what stops someone pre-registering a colleague's
// address and inheriting their Google login.
const oauthMessage = (code: string) =>
  code === "account_not_linked"
    ? "This email already has a password account. Sign in with your password."
    : `Sign-in with that provider didn't complete (${code}).`;

export const Route = createFileRoute("/login")({
  validateSearch: (s: Record<string, unknown>): { redirect?: string; error?: string } => ({
    redirect: typeof s.redirect === "string" ? s.redirect : undefined,
    error: typeof s.error === "string" ? s.error : undefined,
  }),
  // Auth lives on the apex only. Already signed in? Hand off to the apex dispatcher (`/`),
  // or straight back to `redirect` (the page a 401 bounced from, see orpc.ts) when it's safe.
  beforeLoad: async ({ context, search, location }) => {
    if (!isApex()) return hardRedirect(apexUrl(`/login${location.searchStr}`));
    const data = await context.queryClient.ensureQueryData(sessionQuery);
    if (data?.session) {
      const to = safeRedirect(search.redirect);
      if (to) return hardRedirect(to);
      throw redirect({ to: "/" });
    }
  },
  component: Login,
});

function Login() {
  const navigate = useNavigate();
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
      if (res.error) throw new Error(res.error.message ?? "Sign in failed");
      return res.data;
    },
    // `/` is the apex dispatcher — it routes to the user's tenant subdomain, or onboarding.
    onSuccess: async () => {
      // Invalidate the cached null session and re-fetch with the newly-set cookie
      // so _authed's beforeLoad → ensureQueryData sees the real session.
      // staleTime:0 is load-bearing: a cached `null` counts as a cache hit, so ensureQueryData
      // would never refetch after sign-in.
      await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
      const to = safeRedirect(redirectTo);
      if (to) return void hardRedirect(to);
      navigate({ to: "/" });
    },
  });

  const submit = () => email && password && signIn.mutate({ email, password });
  const error = signIn.error?.message ?? (oauthError ? oauthMessage(oauthError) : null);

  return (
    <AuthLayout>
      <h2 className="auth-h1">Welcome back</h2>
      <p className="auth-sub">Sign in to your Confire workspace.</p>
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
      <div className="auth-or">or</div>
      <SocialButtons />
      <p className="auth-alt">
        New to Confire? <Link to="/signup" search={{ redirect: redirectTo }}>Create an account</Link>
      </p>
    </AuthLayout>
  );
}
