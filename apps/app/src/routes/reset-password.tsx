import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Input, Button, MessageStrip } from "@ui5/webcomponents-react";
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
        <h2 className="auth-h1">{i18n.getText("SHELL_AUTH_LINK_DEAD")}</h2>
        <p className="auth-sub">{i18n.getText("SHELL_AUTH_LINK_DEAD_SUB")}</p>
        <p className="auth-alt"><Link to="/forgot-password">{i18n.getText("SHELL_AUTH_SEND_NEW_LINK")}</Link></p>
      </AuthLayout>
    );
  }

  if (reset.isSuccess) {
    return (
      <AuthLayout>
        <h2 className="auth-h1">{i18n.getText("SHELL_AUTH_PASSWORD_CHANGED")}</h2>
        <p className="auth-sub">{i18n.getText("SHELL_AUTH_PASSWORD_CHANGED_SUB")}</p>
        <p className="auth-alt"><Link to="/login">{i18n.getText("SHELL_AUTH_SIGN_IN")}</Link></p>
      </AuthLayout>
    );
  }

  const mismatch = repeat.length > 0 && repeat !== password;
  const submit = () => password && !mismatch && repeat && reset.mutate(password);

  return (
    <AuthLayout>
      <h2 className="auth-h1">{i18n.getText("SHELL_AUTH_CHOOSE_PASSWORD")}</h2>
      <p className="auth-sub">{i18n.getText("SHELL_AUTH_PASSWORD_RULE")}</p>
      {reset.error ? <MessageStrip design="Negative" hideCloseButton>{reset.error.message}</MessageStrip> : null}
      <label className="auth-field">
        <span>{i18n.getText("SHELL_AUTH_NEW_PASSWORD")}</span>
        <Input type="Password" value={password} onInput={(e) => setPassword(e.target.value)} />
      </label>
      <label className="auth-field">
        <span>{i18n.getText("SHELL_AUTH_REPEAT_PASSWORD")}</span>
        <Input
          type="Password"
          value={repeat}
          valueState={mismatch ? "Negative" : "None"}
          valueStateMessage={<span>{i18n.getText("SHELL_AUTH_PASSWORD_MISMATCH")}</span>}
          onInput={(e) => setRepeat(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </label>
      <Button design="Emphasized" disabled={!password || !repeat || mismatch || reset.isPending} onClick={submit}>
        {reset.isPending ? i18n.getText("SHELL_AUTH_SAVING") : i18n.getText("SHELL_AUTH_CHANGE_PASSWORD")}
      </Button>
    </AuthLayout>
  );
}
