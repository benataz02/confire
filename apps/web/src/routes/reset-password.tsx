import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Input, Button, MessageStrip } from "@ui5/webcomponents-react";
import { authClient } from "../auth-client.ts";
import { AuthLayout } from "../components/AuthLayout.tsx";
import { authUrl, hardRedirect, isAuthHost } from "../lib/tenant.ts";

// The mailed link goes to Better Auth's /api/auth/reset-password/<token>, which checks the token and
// redirects here with ?token=… — or with ?error=INVALID_TOKEN when it is unknown, used or expired.
export const Route = createFileRoute("/reset-password")({
  validateSearch: (s: Record<string, unknown>): { token?: string; error?: string } => ({
    token: typeof s.token === "string" ? s.token : undefined,
    error: typeof s.error === "string" ? s.error : undefined,
  }),
  beforeLoad: ({ location }) => {
    if (!isAuthHost()) return hardRedirect(authUrl(`/reset-password${location.searchStr}`));
  },
  component: ResetPassword,
});

function ResetPassword() {
  const { token, error } = Route.useSearch();
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const reset = useMutation({
    mutationFn: async (newPassword: string) => {
      const res = await authClient.resetPassword({ newPassword, token: token! });
      if (res.error) throw new Error(res.error.message ?? "Could not change the password");
    },
  });

  if (error || !token) {
    return (
      <AuthLayout>
        <h2 className="auth-h1">This link no longer works</h2>
        <p className="auth-sub">Reset links work once, for one hour. Ask for a new one.</p>
        <p className="auth-alt"><Link to="/forgot-password">Send a new link</Link></p>
      </AuthLayout>
    );
  }

  if (reset.isSuccess) {
    return (
      <AuthLayout>
        <h2 className="auth-h1">Password changed</h2>
        <p className="auth-sub">You were signed out everywhere. Sign in with your new password.</p>
        <p className="auth-alt"><Link to="/login">Sign in</Link></p>
      </AuthLayout>
    );
  }

  const mismatch = repeat.length > 0 && repeat !== password;
  const submit = () => password && !mismatch && repeat && reset.mutate(password);

  return (
    <AuthLayout>
      <h2 className="auth-h1">Choose a new password</h2>
      <p className="auth-sub">At least 8 characters.</p>
      {reset.error ? <MessageStrip design="Negative" hideCloseButton>{reset.error.message}</MessageStrip> : null}
      <label className="auth-field">
        <span>New password</span>
        <Input type="Password" value={password} onInput={(e) => setPassword(e.target.value)} />
      </label>
      <label className="auth-field">
        <span>Repeat it</span>
        <Input
          type="Password"
          value={repeat}
          valueState={mismatch ? "Negative" : "None"}
          valueStateMessage={<span>The two passwords differ</span>}
          onInput={(e) => setRepeat(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </label>
      <Button design="Emphasized" disabled={!password || !repeat || mismatch || reset.isPending} onClick={submit}>
        {reset.isPending ? "Saving…" : "Change password"}
      </Button>
    </AuthLayout>
  );
}
