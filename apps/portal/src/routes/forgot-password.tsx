import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Input, Button, MessageStrip } from "@ui5/webcomponents-react";
import { authClient, captcha } from "../auth-client.ts";
import { PortalAuthLayout } from "../components/AuthChrome.tsx";
import { Turnstile } from "../components/Turnstile.tsx";
import { apexUrl, authParams, authSearch, hardRedirect, isApex } from "../lib/host.ts";

export const Route = createFileRoute("/forgot-password")({
  validateSearch: authParams,
  beforeLoad: ({ location }) => {
    if (!isApex()) return hardRedirect(apexUrl(`/forgot-password${location.searchStr}`));
  },
  component: ForgotPassword,
});

function ForgotPassword() {
  const { t } = Route.useSearch();
  const [email, setEmail] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const request = useMutation({
    // Better Auth answers the same for an unknown address, so the page can only ever say "if".
    // `t` rides on redirectTo: the mail and the reset page wear the supplier's branding.
    mutationFn: async () => {
      const res = await authClient.requestPasswordReset({
        email,
        redirectTo: apexUrl(`/reset-password${authSearch(undefined, t)}`),
        fetchOptions: captcha(token!),
      });
      if (res.error) throw new Error(res.error.message ?? "Could not send the link");
    },
    onSettled: () => setEpoch((n) => n + 1),
  });
  const ready = !!email && !!token && !request.isPending;
  const submit = () => ready && request.mutate();

  if (request.isSuccess) {
    return (
      <PortalAuthLayout slug={t}>
        <h2 className="auth-h1">Check your inbox</h2>
        <p className="auth-sub">
          If <strong>{email}</strong> has an account, we've sent it a link to choose a new password.
          The link works once, for one hour.
        </p>
        <p className="auth-alt"><Link to="/login" search={{ t }}>Back to sign in</Link></p>
      </PortalAuthLayout>
    );
  }

  return (
    <PortalAuthLayout slug={t}>
      <h2 className="auth-h1">Reset your password</h2>
      <p className="auth-sub">We'll email you a link to choose a new one.</p>
      {request.error ? <MessageStrip design="Negative" hideCloseButton>{request.error.message}</MessageStrip> : null}
      <label className="auth-field">
        <span>Email</span>
        <Input type="Email" value={email} onInput={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      </label>
      <Turnstile onToken={setToken} epoch={epoch} action="reset-request" />
      <Button design="Emphasized" disabled={!ready} onClick={submit}>
        {request.isPending ? "Sending…" : "Send link"}
      </Button>
      <p className="auth-alt">Remembered it? <Link to="/login" search={{ t }}>Sign in</Link></p>
    </PortalAuthLayout>
  );
}
