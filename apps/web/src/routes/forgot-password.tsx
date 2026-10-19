import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Input, Button, MessageStrip } from "@ui5/webcomponents-react";
import { authClient } from "../auth-client.ts";
import { AuthLayout } from "../components/AuthLayout.tsx";
import { authUrl, hardRedirect, onSignInHost } from "../lib/tenant.ts";

export const Route = createFileRoute("/forgot-password")({
  // Auth lives on the sign-in host, and the reset link comes back to it (redirectTo below).
  beforeLoad: ({ location }) => {
    if (!onSignInHost()) return hardRedirect(authUrl(`/forgot-password${location.searchStr}`));
  },
  component: ForgotPassword,
});

function ForgotPassword() {
  const [email, setEmail] = useState("");
  const request = useMutation({
    mutationFn: async (address: string) => {
      // Better Auth answers the same for an unknown address, so the page can only ever say "if".
      const res = await authClient.requestPasswordReset({ email: address, redirectTo: authUrl("/reset-password") });
      if (res.error) throw new Error(res.error.message ?? "Could not send the link");
    },
  });
  const submit = () => email && request.mutate(email);

  if (request.isSuccess) {
    return (
      <AuthLayout>
        <h2 className="auth-h1">Check your inbox</h2>
        <p className="auth-sub">
          If <strong>{email}</strong> has an account, we've sent it a link to choose a new password.
          The link works once, for one hour.
        </p>
        <p className="auth-alt"><Link to="/login">Back to sign in</Link></p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <h2 className="auth-h1">Reset your password</h2>
      <p className="auth-sub">We'll email you a link to choose a new one.</p>
      {request.error ? <MessageStrip design="Negative" hideCloseButton>{request.error.message}</MessageStrip> : null}
      <label className="auth-field">
        <span>Email</span>
        <Input type="Email" value={email} onInput={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      </label>
      <Button design="Emphasized" disabled={!email || request.isPending} onClick={submit}>
        {request.isPending ? "Sending…" : "Send link"}
      </Button>
      <p className="auth-alt">Remembered it? <Link to="/login">Sign in</Link></p>
    </AuthLayout>
  );
}
