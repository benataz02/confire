import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Input, Button, MessageStrip } from "@ui5/webcomponents-react";
import { authClient, sessionQuery } from "../auth-client.ts";
import { AuthLayout } from "../components/AuthLayout.tsx";
import { SocialButtons } from "../components/SocialButtons.tsx";
import { authUrl, hardRedirect, currentSlug } from "@confire/ui/host.ts";

export const Route = createFileRoute("/signup")({
  validateSearch: (s: Record<string, unknown>): { redirect?: string } => ({
    redirect: typeof s.redirect === "string" ? s.redirect : undefined,
  }),
  // Already signed in: the dispatcher (/login) takes it from here.
  beforeLoad: async ({ context, search, location }) => {
    if (currentSlug()) return hardRedirect(authUrl(`/signup${location.searchStr}`));
    const data = await context.queryClient.ensureQueryData(sessionQuery);
    if (data?.session) throw redirect({ to: "/login", search });
  },
  component: Signup,
});

function Signup() {
  const { redirect: redirectTo } = Route.useSearch();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const signUp = useMutation({
    // Unconditional for the same reason as login: a session belonging to someone else must
    // never pass for "signed up".
    mutationFn: async (vars: { name: string; email: string; password: string }) => {
      // No session comes back: the address has to be confirmed first (auth.ts). The link's
      // callbackURL is login, carrying `redirect` on: confirming signs the user in, and login then
      // dispatches (to `redirect`, or the user's place); a dead link lands there as ?error=<code>.
      const callbackURL = authUrl(`/login${redirectTo ? `?${new URLSearchParams({ redirect: redirectTo })}` : ""}`);
      const res = await authClient.signUp.email({ ...vars, callbackURL });
      if (res.error) throw new Error(res.error.message ?? "Sign up failed");
      return res.data;
    },
  });

  const submit = () => name && email && password && signUp.mutate({ name, email, password });

  if (signUp.isSuccess) {
    return (
      <AuthLayout>
        <h2 className="auth-h1">Check your inbox</h2>
        <p className="auth-sub">
          We've sent a link to <strong>{email}</strong>. Open it to confirm your address and finish
          setting up your account.
        </p>
        <p className="auth-alt">
          Nothing arrived? Signing in sends a new link. <Link to="/login" search={{ redirect: redirectTo }}>Sign in</Link>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <h2 className="auth-h1">Create your account</h2>
      <p className="auth-sub">Use your work email address.</p>
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
        <Input
          type="Password"
          value={password}
          onInput={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </label>
      <Button design="Emphasized" disabled={signUp.isPending} onClick={submit}>
        {signUp.isPending ? "Creating…" : "Create account"}
      </Button>
      <div className="auth-or">or</div>
      <SocialButtons redirect={redirectTo} />
      <p className="auth-alt">
        Already have an account? <Link to="/login" search={{ redirect: redirectTo }}>Sign in</Link>
      </p>
    </AuthLayout>
  );
}
