import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { MessageStrip } from "@ui5/webcomponents-react";
import { AuthCard, AuthField, AuthHead, AuthTile } from "@confire/ui/auth/AuthLayout.tsx";
import { authClient } from "../auth-client.ts";
import { AuthLayout } from "../components/AuthLayout.tsx";
import { authUrl, hardRedirect, currentSlug } from "@confire/ui/host.ts";
import { useI18n } from "../i18n.ts";

// The mailed link goes to Better Auth's /api/auth/reset-password/<token>, which checks the token and
// redirects here with ?token=… — or with ?error=INVALID_TOKEN when it is unknown, used or expired.
export const Route = createFileRoute("/reset-password")({
  validateSearch: (s: Record<string, unknown>): { token?: string; error?: string } => ({
    token: typeof s.token === "string" ? s.token : undefined,
    error: typeof s.error === "string" ? s.error : undefined,
  }),
  beforeLoad: ({ location }) => {
    if (currentSlug()) return hardRedirect(authUrl(`/reset-password${location.searchStr}`));
  },
  component: ResetPassword,
});

function ResetPassword() {
  const i18n = useI18n();
  const { token, error } = Route.useSearch();
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const reset = useMutation({
    mutationFn: async (newPassword: string) => {
      const res = await authClient.resetPassword({ newPassword, token: token! });
      if (res.error) throw new Error(res.error.message ?? i18n.getText("SHELL_AUTH_CHANGE_FAILED"));
    },
  });

  if (error || !token) {
    return (
      <AuthLayout>
        <AuthHead title={i18n.getText("SHELL_AUTH_LINK_DEAD")} />
        <AuthCard center>
          <AuthTile icon="message-error" tone="negative" />
          <p className="auth-body">{i18n.getText("SHELL_AUTH_LINK_DEAD_SUB")}</p>
          <Link className="auth-btn auth-btn--em" to="/forgot-password">{i18n.getText("SHELL_AUTH_SEND_NEW_LINK")}</Link>
        </AuthCard>
        <p className="auth-alt"><Link to="/login">{i18n.getText("SHELL_AUTH_BACK_SIGN_IN")}</Link></p>
      </AuthLayout>
    );
  }

  if (reset.isSuccess) {
    return (
      <AuthLayout>
        <AuthHead title={i18n.getText("SHELL_AUTH_PASSWORD_CHANGED")} />
        <AuthCard center>
          <AuthTile icon="accept" tone="positive" />
          <p className="auth-body">{i18n.getText("SHELL_AUTH_PASSWORD_CHANGED_SUB")}</p>
          <Link className="auth-btn auth-btn--em" to="/login">{i18n.getText("SHELL_AUTH_SIGN_IN")}</Link>
        </AuthCard>
      </AuthLayout>
    );
  }

  const mismatch = repeat.length > 0 && repeat !== password;
  const submit = () => password && !mismatch && repeat && reset.mutate(password);

  return (
    <AuthLayout>
      <AuthHead title={i18n.getText("SHELL_AUTH_CHOOSE_PASSWORD")} lead={i18n.getText("SHELL_AUTH_PASSWORD_RULE")} />
      <AuthCard onSubmit={submit}>
        {reset.error ? <MessageStrip design="Negative" hideCloseButton>{reset.error.message}</MessageStrip> : null}
        <AuthField
          label={i18n.getText("SHELL_AUTH_NEW_PASSWORD")} type="password" name="password" autoComplete="new-password" required
          value={password} onChange={(e) => setPassword(e.target.value)}
        />
        <AuthField
          label={i18n.getText("SHELL_AUTH_REPEAT_PASSWORD")} type="password" name="repeat" autoComplete="new-password" required
          error={mismatch ? i18n.getText("SHELL_AUTH_PASSWORD_MISMATCH") : null}
          value={repeat} onChange={(e) => setRepeat(e.target.value)}
        />
        <button type="submit" className="auth-btn auth-btn--em" disabled={!password || !repeat || mismatch || reset.isPending}>
          {reset.isPending ? i18n.getText("SHELL_AUTH_SAVING") : i18n.getText("SHELL_AUTH_CHANGE_PASSWORD")}
        </button>
      </AuthCard>
    </AuthLayout>
  );
}
