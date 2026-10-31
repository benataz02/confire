import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { MessageStrip } from "@ui5/webcomponents-react";
import { AuthCard, AuthField, AuthHead, AuthTile } from "@confire/ui/auth/AuthLayout.tsx";
import { authClient } from "../auth-client.ts";
import { AuthLayout } from "../components/AuthLayout.tsx";
import { authUrl, hardRedirect, currentSlug } from "@confire/ui/host.ts";
import { useI18n } from "../i18n.ts";

function emph(template: string, value: string): ReactNode {
  const [before, after = ""] = template.split("\u0000");
  return <>{before}<strong>{value}</strong>{after}</>;
}

export const Route = createFileRoute("/forgot-password")({
  // Auth lives on the sign-in host, and the reset link comes back to it (redirectTo below).
  beforeLoad: ({ location }) => {
    if (currentSlug()) return hardRedirect(authUrl(`/forgot-password${location.searchStr}`));
  },
  component: ForgotPassword,
});

function ForgotPassword() {
  const i18n = useI18n();
  const [email, setEmail] = useState("");
  const request = useMutation({
    mutationFn: async (address: string) => {
      // Better Auth answers the same for an unknown address, so the page can only ever say "if".
      const res = await authClient.requestPasswordReset({ email: address, redirectTo: authUrl("/reset-password") });
      if (res.error) throw new Error(res.error.message ?? i18n.getText("SHELL_AUTH_SEND_FAILED"));
    },
  });
  const submit = () => email && request.mutate(email);

  if (request.isSuccess) {
    return (
      <AuthLayout>
        <AuthHead title={i18n.getText("SHELL_AUTH_CHECK_INBOX")} />
        <AuthCard center>
          <AuthTile icon="email-read" />
          <p className="auth-body">{emph(i18n.getText("SHELL_AUTH_RESET_SENT", "\u0000"), email)}</p>
          <Link className="auth-btn" to="/login">{i18n.getText("SHELL_AUTH_BACK_SIGN_IN")}</Link>
        </AuthCard>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthHead title={i18n.getText("SHELL_AUTH_RESET_TITLE")} lead={i18n.getText("SHELL_AUTH_RESET_SUB")} />
      <AuthCard onSubmit={submit}>
        {request.error ? <MessageStrip design="Negative" hideCloseButton>{request.error.message}</MessageStrip> : null}
        <AuthField
          label={i18n.getText("SHELL_AUTH_EMAIL")} type="email" name="email" autoComplete="username" required
          value={email} onChange={(e) => setEmail(e.target.value)}
        />
        <button type="submit" className="auth-btn auth-btn--em" disabled={!email || request.isPending}>
          {request.isPending ? i18n.getText("SHELL_AUTH_SENDING") : i18n.getText("SHELL_AUTH_SEND_LINK")}
        </button>
      </AuthCard>
      <p className="auth-alt">{i18n.getText("SHELL_AUTH_REMEMBERED")} <Link to="/login">{i18n.getText("SHELL_AUTH_SIGN_IN")}</Link></p>
    </AuthLayout>
  );
}
