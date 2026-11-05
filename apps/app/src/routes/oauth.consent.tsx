import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BusyIndicator, MessageStrip } from "@ui5/webcomponents-react";
import { AuthCard, AuthHead, AuthTile } from "@confire/ui/auth/AuthLayout.tsx";
import { authUrl, currentSlug, guardRedirect } from "@confire/ui/host.ts";
import { authClient, sessionQuery } from "../auth-client.ts";
import { AuthLayout } from "../components/AuthLayout.tsx";
import { useI18n } from "../i18n.ts";
import { orpc } from "../orpc.ts";

// MCP's consent page (assistant spec §4.10): Better Auth sends the user here, signed in, with a signed
// query naming the client. The client's name and the workspace are read off that query on the server
// (sap.oauthConsent), never off the URL as the browser shows it. Allow/Deny is Better Auth's own
// /oauth2/consent; oauthProviderClient (auth-client.ts) adds the signed query to that call, and the
// answer redirects back to the client.
export const Route = createFileRoute("/oauth/consent")({
  beforeLoad: async ({ context, location, preload }) => {
    if (currentSlug()) return guardRedirect(authUrl(`/oauth/consent${location.searchStr}`), preload);
    const data = await context.queryClient.ensureQueryData(sessionQuery);
    // Signed out (the session ended meanwhile): sign in, which carries the signed query on.
    if (!data?.session) throw redirect({ href: `/login${location.searchStr}` });
  },
  component: Consent,
});

function Consent() {
  const i18n = useI18n();
  const query = window.location.search.slice(1);
  const ask = useQuery({ ...orpc.sap.oauthConsent.queryOptions({ input: { query } }), retry: false });
  const answer = useMutation({
    mutationFn: async (accept: boolean) => {
      const res = await authClient.$fetch<{ url?: string }>("/oauth2/consent", { method: "POST", body: { accept } });
      if (res.error) throw new Error(res.error.message ?? i18n.getText("SHELL_OAUTH_INVALID"));
      if (res.data?.url) window.location.assign(res.data.url);
    },
  });

  if (ask.isPending) return <AuthLayout><BusyIndicator active /></AuthLayout>;
  if (ask.error || !ask.data) {
    return (
      <AuthLayout>
        <AuthHead title={i18n.getText("SHELL_OAUTH_INVALID_TITLE")} />
        <AuthCard center>
          <AuthTile icon="error" tone="negative" />
          <p className="auth-body">{i18n.getText("SHELL_OAUTH_INVALID")}</p>
        </AuthCard>
      </AuthLayout>
    );
  }
  const { client, workspace, email } = ask.data;
  return (
    <AuthLayout>
      <AuthHead title={i18n.getText("SHELL_OAUTH_TITLE", client.name)} />
      <AuthCard>
        <AuthTile icon="connected" />
        {answer.error ? <MessageStrip design="Negative" hideCloseButton>{answer.error.message}</MessageStrip> : null}
        {workspace ? (
          <>
            <p className="auth-body">{i18n.getText("SHELL_OAUTH_LEAD", client.name, email, workspace.name)}</p>
            <p className="auth-body">{i18n.getText("SHELL_OAUTH_WRITES")}</p>
            {client.uri ? <p className="auth-body">{i18n.getText("SHELL_OAUTH_SITE", client.uri)}</p> : null}
            <button type="button" className="auth-btn auth-btn--em" disabled={answer.isPending} onClick={() => answer.mutate(true)}>
              {i18n.getText("SHELL_OAUTH_ALLOW")}
            </button>
          </>
        ) : <p className="auth-body">{i18n.getText("SHELL_OAUTH_NO_WORKSPACE")}</p>}
        <button type="button" className="auth-btn" disabled={answer.isPending} onClick={() => answer.mutate(false)}>
          {i18n.getText("SHELL_OAUTH_DENY")}
        </button>
      </AuthCard>
    </AuthLayout>
  );
}
