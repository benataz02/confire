import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { MessageStrip } from "@ui5/webcomponents-react";
import { AuthCard, AuthField, AuthHead, AuthTile } from "@confire/ui/auth/AuthLayout.tsx";
import { authClient, sessionQuery } from "../auth-client.ts";
import { AuthLayout } from "../components/AuthLayout.tsx";
import { SocialButtons } from "../components/SocialButtons.tsx";
import { authUrl, hardRedirect, currentSlug } from "@confire/ui/host.ts";
import { useI18n } from "../i18n.ts";

/** `template` has a `\u0000` where `{0}` was, so the value can sit in `<strong>`. */
function emph(template: string, value: string): ReactNode {
  const [before, after = ""] = template.split("\u0000");
  return <>{before}<strong>{value}</strong>{after}</>;
}

export const Route = createFileRoute("/signup")({
  // `email`: an invitation's address (the portal's invitationGuard) — fixed, since only that address
  // can accept it.
  validateSearch: (s: Record<string, unknown>): { redirect?: string; email?: string } => ({
    redirect: typeof s.redirect === "string" ? s.redirect : undefined,
    email: typeof s.email === "string" ? s.email : undefined,
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
  const i18n = useI18n();
  const { redirect: redirectTo, email: invited } = Route.useSearch();
  const [name, setName] = useState("");
  const [email, setEmail] = useState(invited ?? "");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");

  const signUp = useMutation({
    // Unconditional for the same reason as login: a session belonging to someone else must
    // never pass for "signed up".
    mutationFn: async (vars: { name: string; email: string; password: string }) => {
      // No session comes back: the address has to be confirmed first (auth.ts). The link's
      // callbackURL is login, carrying `redirect` on: confirming signs the user in, and login then
      // dispatches (to `redirect`, or the user's place); a dead link lands there as ?error=<code>.
      const callbackURL = authUrl(`/login${redirectTo ? `?${new URLSearchParams({ redirect: redirectTo })}` : ""}`);
      const res = await authClient.signUp.email({ ...vars, callbackURL });
      if (res.error) throw new Error(res.error.message ?? i18n.getText("SHELL_AUTH_SIGN_UP_FAILED"));
      return res.data;
    },
  });

  const mismatch = repeat.length > 0 && repeat !== password;
  const submit = () => name && email && password && repeat && !mismatch && signUp.mutate({ name, email, password });

  if (signUp.isSuccess) {
    return (
      <AuthLayout>
        <AuthHead title={i18n.getText("SHELL_AUTH_CHECK_INBOX")} />
        <AuthCard center>
          <AuthTile icon="email-read" />
          <p className="auth-body">{emph(i18n.getText("SHELL_AUTH_VERIFY_SENT", "\u0000"), email)}</p>
          <p className="auth-note">{i18n.getText("SHELL_AUTH_VERIFY_RETRY")}</p>
          <Link className="auth-btn" to="/login" search={{ redirect: redirectTo, email }}>{i18n.getText("SHELL_AUTH_BACK_SIGN_IN")}</Link>
        </AuthCard>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthHead title={i18n.getText("SHELL_AUTH_CREATE_TITLE")} lead={i18n.getText("SHELL_AUTH_CREATE_SUB")} />
      <AuthCard onSubmit={submit}>
        {signUp.error ? <MessageStrip design="Negative" hideCloseButton>{signUp.error.message}</MessageStrip> : null}
        <SocialButtons redirect={redirectTo} />
        <div className="auth-or">{i18n.getText("SHELL_AUTH_OR")}</div>
        <AuthField label={i18n.getText("SHELL_AUTH_NAME")} name="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
        <AuthField
          label={i18n.getText("SHELL_AUTH_WORK_EMAIL")} type="email" name="email" autoComplete="username" required
          readOnly={invited !== undefined} value={email} onChange={(e) => setEmail(e.target.value)}
        />
        <div className="auth-row">
          <AuthField
            label={i18n.getText("SHELL_AUTH_PASSWORD")} type="password" name="password" autoComplete="new-password" required
            value={password} onChange={(e) => setPassword(e.target.value)}
          />
          <AuthField
            label={i18n.getText("SHELL_AUTH_REPEAT_PASSWORD")} type="password" name="repeat" autoComplete="new-password" required
            error={mismatch ? i18n.getText("SHELL_AUTH_PASSWORD_MISMATCH") : null}
            value={repeat} onChange={(e) => setRepeat(e.target.value)}
          />
        </div>
        <button type="submit" className="auth-btn auth-btn--em" disabled={signUp.isPending || mismatch}>
          {signUp.isPending ? i18n.getText("SHELL_AUTH_CREATING") : i18n.getText("SHELL_AUTH_CREATE_ACCOUNT")}
        </button>
      </AuthCard>
      <p className="auth-alt">
        {i18n.getText("SHELL_AUTH_HAVE_ACCOUNT")} <Link to="/login" search={{ redirect: redirectTo, email: invited }}>{i18n.getText("SHELL_AUTH_SIGN_IN")}</Link>
      </p>
    </AuthLayout>
  );
}
