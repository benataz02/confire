import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Input, Button, MessageStrip } from "@ui5/webcomponents-react";
import { authClient } from "../auth-client.ts";
import { PortalAuthLayout } from "../components/AuthChrome.tsx";
import { apexUrl, authParams, hardRedirect, isApex } from "../lib/host.ts";

// The mailed link goes to Better Auth's /api/auth/reset-password/<token>, which checks the token and
// redirects here with ?token=… — or with ?error=INVALID_TOKEN when it is unknown, used or expired.
// Setting the password needs no captcha: holding a valid single-use token is the proof.
export const Route = createFileRoute("/reset-password")({
  validateSearch: authParams,
  beforeLoad: ({ location }) => {
    if (!isApex()) return hardRedirect(apexUrl(`/reset-password${location.searchStr}`));
  },
  component: ResetPassword,
});

function ResetPassword() {
  const { token, error, t } = Route.useSearch();
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const reset = useMutation({
    mutationFn: async () => {
      const res = await authClient.resetPassword({ newPassword: password, token: token! });
      if (res.error) throw new Error(res.error.message ?? "Could not change the password");
    },
  });

  if (error || !token) {
    return (
      <PortalAuthLayout slug={t}>
        <h2 className="auth-h1">This link no longer works</h2>
        <p className="auth-sub">Reset links work once, for one hour. Ask for a new one.</p>
        <p className="auth-alt"><Link to="/forgot-password" search={{ t }}>Send a new link</Link></p>
      </PortalAuthLayout>
    );
  }

  if (reset.isSuccess) {
    return (
      <PortalAuthLayout slug={t}>
        <h2 className="auth-h1">Password changed</h2>
        <p className="auth-sub">You were signed out of the portal everywhere. Sign in with your new password.</p>
        <p className="auth-alt"><Link to="/login" search={{ t }}>Sign in</Link></p>
      </PortalAuthLayout>
    );
  }

  const mismatch = repeat.length > 0 && repeat !== password;
  const submit = () => password && repeat && !mismatch && reset.mutate();

  return (
    <PortalAuthLayout slug={t}>
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
    </PortalAuthLayout>
  );
}
