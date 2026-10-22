import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Input, Button, MessageStrip } from "@ui5/webcomponents-react";
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
  const i18n = useI18n();
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
      if (res.error) throw new Error(res.error.message ?? i18n.getText("SHELL_AUTH_SIGN_UP_FAILED"));
      return res.data;
    },
  });

  const submit = () => name && email && password && signUp.mutate({ name, email, password });

  if (signUp.isSuccess) {
    return (
      <AuthLayout>
        <h2 className="auth-h1">{i18n.getText("SHELL_AUTH_CHECK_INBOX")}</h2>
        <p className="auth-sub">
          {emph(i18n.getText("SHELL_AUTH_VERIFY_SENT", "\u0000"), email)}
        </p>
        <p className="auth-alt">
          {i18n.getText("SHELL_AUTH_VERIFY_RETRY")} <Link to="/login" search={{ redirect: redirectTo }}>{i18n.getText("SHELL_AUTH_SIGN_IN")}</Link>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <h2 className="auth-h1">{i18n.getText("SHELL_AUTH_CREATE_TITLE")}</h2>
      <p className="auth-sub">{i18n.getText("SHELL_AUTH_CREATE_SUB")}</p>
      {signUp.error ? <MessageStrip design="Negative" hideCloseButton>{signUp.error.message}</MessageStrip> : null}
      <label className="auth-field">
        <span>{i18n.getText("SHELL_AUTH_NAME")}</span>
        <Input value={name} onInput={(e) => setName(e.target.value)} />
      </label>
      <label className="auth-field">
        <span>{i18n.getText("SHELL_AUTH_WORK_EMAIL")}</span>
        <Input type="Email" value={email} onInput={(e) => setEmail(e.target.value)} />
      </label>
      <label className="auth-field">
        <span>{i18n.getText("SHELL_AUTH_PASSWORD")}</span>
        <Input
          type="Password"
          value={password}
          onInput={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </label>
      <Button design="Emphasized" disabled={signUp.isPending} onClick={submit}>
        {signUp.isPending ? i18n.getText("SHELL_AUTH_CREATING") : i18n.getText("SHELL_AUTH_CREATE_ACCOUNT")}
      </Button>
      <div className="auth-or">{i18n.getText("SHELL_AUTH_OR")}</div>
      <SocialButtons redirect={redirectTo} />
      <p className="auth-alt">
        {i18n.getText("SHELL_AUTH_HAVE_ACCOUNT")} <Link to="/login" search={{ redirect: redirectTo }}>{i18n.getText("SHELL_AUTH_SIGN_IN")}</Link>
      </p>
    </AuthLayout>
  );
}
