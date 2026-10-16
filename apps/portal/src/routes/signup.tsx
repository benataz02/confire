import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Input, Button, MessageStrip } from "@ui5/webcomponents-react";
import { authClient, captcha, sessionQuery } from "../auth-client.ts";
import { PortalAuthLayout, PortalSocialButtons } from "../components/AuthChrome.tsx";
import { Turnstile } from "../components/Turnstile.tsx";
import { apexUrl, authParams, authSearch, hardRedirect, isApex, safeRedirect } from "../lib/host.ts";

// An account, not a company: anyone may create one (an invitee has to). Getting into a supplier's
// company takes an invitation or a registered email domain (spec §4.4, §5).
export const Route = createFileRoute("/signup")({
  validateSearch: authParams,
  beforeLoad: async ({ context, search, location }) => {
    if (!isApex()) return hardRedirect(apexUrl(`/signup${location.searchStr}`));
    const data = await context.queryClient.ensureQueryData(sessionQuery);
    if (data?.session) {
      const to = safeRedirect(search.redirect);
      if (to) return hardRedirect(to);
      throw redirect({ to: "/" });
    }
  },
  component: Signup,
});

function Signup() {
  const { redirect: redirectTo, t } = Route.useSearch();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);

  const signUp = useMutation({
    // No session comes back until the address is confirmed. The link returns to login carrying
    // `redirect` and `t`: confirming signs the user in, and login hands off to `redirect`.
    mutationFn: async () => {
      const res = await authClient.signUp.email({
        name, email, password,
        callbackURL: apexUrl(`/login${authSearch(redirectTo, t)}`),
        fetchOptions: captcha(token!),
      });
      if (res.error) throw new Error(res.error.message ?? "Sign up failed");
    },
    onSettled: () => setEpoch((n) => n + 1),
  });

  const ready = !!name && !!email && !!password && !!token && !signUp.isPending;
  const submit = () => ready && signUp.mutate();

  if (signUp.isSuccess) {
    return (
      <PortalAuthLayout slug={t}>
        <h2 className="auth-h1">Check your inbox</h2>
        <p className="auth-sub">
          We've sent a link to <strong>{email}</strong>. Open it to confirm your address and continue.
        </p>
        <p className="auth-alt">
          Nothing arrived? Signing in sends a new link. <Link to="/login" search={{ redirect: redirectTo, t }}>Sign in</Link>
        </p>
      </PortalAuthLayout>
    );
  }

  return (
    <PortalAuthLayout slug={t}>
      <h2 className="auth-h1">Create your account</h2>
      <p className="auth-sub">Use the email address your supplier knows you by.</p>
      {signUp.error ? <MessageStrip design="Negative" hideCloseButton>{signUp.error.message}</MessageStrip> : null}
      <label className="auth-field">
        <span>Name</span>
        <Input value={name} onInput={(e) => setName(e.target.value)} />
      </label>
      <label className="auth-field">
        <span>Work email</span>
        <Input type="Email" value={email} onInput={(e) => setEmail(e.target.value)} />
      </label>
      <label className="auth-field">
        <span>Password</span>
        <Input type="Password" value={password} onInput={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      </label>
      <Turnstile onToken={setToken} epoch={epoch} action="sign-up" />
      <Button design="Emphasized" disabled={!ready} onClick={submit}>
        {signUp.isPending ? "Creating…" : "Create account"}
      </Button>
      <div className="auth-or">or</div>
      <PortalSocialButtons redirect={redirectTo} t={t} />
      <p className="auth-alt">
        Already have an account? <Link to="/login" search={{ redirect: redirectTo, t }}>Sign in</Link>
      </p>
    </PortalAuthLayout>
  );
}
