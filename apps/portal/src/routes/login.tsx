import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Input, Button, MessageStrip } from "@ui5/webcomponents-react";
import { authErrorMessage, notVerifiedMessage } from "@confire/ui/auth/messages.ts";
import { authClient, captcha, sessionQuery } from "../auth-client.ts";
import { PortalAuthLayout, PortalSocialButtons } from "../components/AuthChrome.tsx";
import { Turnstile } from "../components/Turnstile.tsx";
import { apexUrl, authParams, hardRedirect, isApex, safeRedirect } from "../lib/host.ts";

export const Route = createFileRoute("/login")({
  validateSearch: authParams,
  // Auth lives on the portal apex. Already signed in? Straight back to `redirect` when it is this
  // zone's, else the supplier lobby.
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
  const { redirect: redirectTo, t, error: linkError } = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);

  const signIn = useMutation({
    // Unconditional, as in the internal app: another tab's session must never pass for this one.
    // callbackURL is the destination, so Better Auth's client makes the one navigation on success —
    // and the fresh confirmation link an unverified sign-in mails returns there too (an invitation
    // link, from P3 on), instead of to the lobby.
    mutationFn: async () => {
      const res = await authClient.signIn.email({
        email,
        password,
        callbackURL: safeRedirect(redirectTo) ?? apexUrl("/"),
        fetchOptions: captcha(token!),
      });
      if (res.error?.code === "EMAIL_NOT_VERIFIED") throw new Error(notVerifiedMessage(email));
      if (res.error) throw new Error(res.error.message ?? "Sign in failed");
    },
    onSettled: () => setEpoch((n) => n + 1), // the token is spent either way
  });

  const ready = !!email && !!password && !!token && !signIn.isPending;
  const submit = () => ready && signIn.mutate();
  const error = signIn.error?.message ?? (linkError ? authErrorMessage(linkError) : null);

  return (
    <PortalAuthLayout slug={t}>
      <h2 className="auth-h1">Welcome back</h2>
      <p className="auth-sub">Sign in to your customer portal.</p>
      {error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : null}
      <label className="auth-field">
        <span>Email</span>
        <Input type="Email" value={email} onInput={(e) => setEmail(e.target.value)} />
      </label>
      <label className="auth-field">
        <span>Password</span>
        <Input type="Password" value={password} onInput={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      </label>
      <Turnstile onToken={setToken} epoch={epoch} action="sign-in" />
      <Button design="Emphasized" disabled={!ready} onClick={submit}>
        {signIn.isPending ? "Signing in…" : "Sign in"}
      </Button>
      <p className="auth-alt">
        <Link to="/forgot-password" search={{ t }}>Forgot your password?</Link>
      </p>
      <div className="auth-or">or</div>
      <PortalSocialButtons redirect={redirectTo} t={t} />
      <p className="auth-alt">
        New here? <Link to="/signup" search={{ redirect: redirectTo, t }}>Create an account</Link>
      </p>
    </PortalAuthLayout>
  );
}
