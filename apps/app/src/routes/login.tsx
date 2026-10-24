import { createFileRoute, redirect, useRouter, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Input, Button, MessageStrip, List, ListItemStandard } from "@ui5/webcomponents-react";
import { authClient, sessionQuery } from "../auth-client.ts";
import { lobbyQuery } from "../orpc.ts";
import { AuthLayout } from "../components/AuthLayout.tsx";
import { SocialButtons } from "../components/SocialButtons.tsx";
import { authUrl, hardRedirect, currentSlug, safeRedirect } from "@confire/ui/host.ts";
import { authErrorMessage, notVerifiedMessage } from "@confire/ui/auth/messages.ts";
import { useI18n } from "../i18n.ts";

type Place = {
  url: string;
  active: boolean;
  title: string;
  icon: string;
  kind: "workspace" | "portal";
  cardName?: string;
  role?: string;
};

const ROLE_KEY: Record<string, string> = {
  owner: "SHELL_ROLE_OWNER",
  buyer: "SHELL_ROLE_BUYER",
  viewer: "SHELL_ROLE_VIEWER",
};

// The one sign-in for staff and customers, and the dispatcher (spec 2026-10-19-path-tenancy-design.md).
// Signed out it is the form. Signed in it sends the user on: to `redirect` (the page a 401 bounced
// from — that app's own guard decides from there, which is how a portal stays invite-only), else to
// the place the session last worked in (staff app or portal), else to their one place, else it renders
// "Where to?" — which `?choose` asks for outright ("Switch supplier"). No place at all is workspace
// setup. ?error=<code> (social sign-in, a dead verification link) reads through authErrorMessage.
export const Route = createFileRoute("/login")({
  validateSearch: (s: Record<string, unknown>): { redirect?: string; error?: string; choose?: boolean; email?: string } => ({
    redirect: typeof s.redirect === "string" ? s.redirect : undefined,
    email: typeof s.email === "string" ? s.email : undefined,
    error: typeof s.error === "string" ? s.error : undefined,
    choose: s.choose !== undefined ? true : undefined,
  }),
  beforeLoad: async ({ context, search, location }) => {
    if (currentSlug()) return hardRedirect(authUrl(`/login${location.searchStr}`));
    const data = await context.queryClient.ensureQueryData(sessionQuery);
    if (!data?.session) return { places: null };
    const to = safeRedirect(search.redirect);
    if (to) return hardRedirect(to);
    const { workspace, portals } = await context.queryClient.fetchQuery(lobbyQuery);
    if (!workspace && !portals.length) throw redirect({ to: "/onboarding" });
    if (workspace?.needsAgent) throw redirect({ to: "/onboarding" });
    const places: Place[] = [
      ...(workspace ? [{ url: workspace.url, active: workspace.active, title: workspace.name, icon: "building", kind: "workspace" as const }] : []),
      ...portals.map((p) => ({
        url: p.url, active: p.active, title: p.tenantName, icon: "supplier", kind: "portal" as const,
        cardName: p.cardName, role: p.role,
      })),
    ];
    if (!search.choose) {
      const next = places.length === 1 ? places[0] : places.find((p) => p.active);
      if (next) return hardRedirect(next.url);
    }
    return { places };
  },
  component: Login,
});

function Login() {
  const { places } = Route.useRouteContext();
  return places ? <WhereTo places={places} /> : <SignIn />;
}

function SignIn() {
  const i18n = useI18n();
  const router = useRouter();
  const { redirect: redirectTo, error: oauthError, email: invited } = Route.useSearch();
  const [email, setEmail] = useState(invited ?? "");
  const [password, setPassword] = useState("");

  const queryClient = useQueryClient();

  const signIn = useMutation({
    // Deliberately unconditional: an existing session must NOT short-circuit this. Another tab
    // can sign in as someone else while this page sits open, and returning that session would
    // hand these credentials the wrong workspace. Better Auth replaces the session cookie.
    mutationFn: async (vars: { email: string; password: string }) => {
      const res = await authClient.signIn.email(vars);
      // Unverified: Better Auth has just mailed a fresh link (sendOnSignIn), so say where it went.
      if (res.error?.code === "EMAIL_NOT_VERIFIED") throw new Error(notVerifiedMessage(vars.email));
      if (res.error) throw new Error(res.error.message ?? i18n.getText("SHELL_AUTH_SIGN_IN_FAILED"));
      return res.data;
    },
    onSuccess: async () => {
      // staleTime:0 is load-bearing: a cached `null` counts as a cache hit, so ensureQueryData
      // would never refetch after sign-in. Then re-run beforeLoad: signed in, it dispatches.
      await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
      await router.invalidate();
    },
  });

  const submit = () => email && password && signIn.mutate({ email, password });
  const error = signIn.error?.message ?? (oauthError ? authErrorMessage(oauthError) : null);

  return (
    <AuthLayout>
      <h2 className="auth-h1">{i18n.getText("SHELL_AUTH_WELCOME")}</h2>
      <p className="auth-sub">{i18n.getText("SHELL_AUTH_SIGN_IN_SUB")}</p>
      {error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : null}
      <label className="auth-field">
        <span>{i18n.getText("SHELL_AUTH_EMAIL")}</span>
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
      <Button design="Emphasized" disabled={signIn.isPending} onClick={submit}>
        {signIn.isPending ? i18n.getText("SHELL_AUTH_SIGN_IN_PENDING") : i18n.getText("SHELL_AUTH_SIGN_IN")}
      </Button>
      <p className="auth-alt"><Link to="/forgot-password">{i18n.getText("SHELL_AUTH_FORGOT")}</Link></p>
      <div className="auth-or">{i18n.getText("SHELL_AUTH_OR")}</div>
      <SocialButtons redirect={redirectTo} />
      <p className="auth-alt">
        {i18n.getText("SHELL_AUTH_NEW")} <Link to="/signup" search={{ redirect: redirectTo, email: invited }}>{i18n.getText("SHELL_AUTH_CREATE_ACCOUNT_LINK")}</Link>
      </p>
    </AuthLayout>
  );
}

/** More than one place (spec S6): the workspace first, then each supplier portal. */
function WhereTo({ places }: { places: Place[] }) {
  const i18n = useI18n();
  const queryClient = useQueryClient();
  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    window.location.assign("/login");
  };
  return (
    <AuthLayout>
      <h2 className="auth-h1">{i18n.getText("SHELL_AUTH_WHERE")}</h2>
      <List
        onItemClick={(e) => {
          const url = (e.detail.item as HTMLElement).dataset.url;
          if (url) void hardRedirect(url);
        }}
      >
        {places.map((p) => {
          const roleKey = p.role ? ROLE_KEY[p.role] : undefined;
          return (
            <ListItemStandard
              key={p.url}
              data-url={p.url}
              icon={p.icon}
              description={p.kind === "workspace"
                ? i18n.getText("SHELL_AUTH_YOUR_WORKSPACE")
                : i18n.getText("SHELL_AUTH_CUSTOMER_PORTAL", p.cardName ?? "")}
              additionalText={roleKey ? i18n.getText(roleKey) : p.role}
            >
              {p.title}
            </ListItemStandard>
          );
        })}
      </List>
      <p className="auth-alt">
        <a href="/login" onClick={(e) => { e.preventDefault(); void signOut(); }}>{i18n.getText("SHELL_AUTH_SIGN_OUT")}</a>
      </p>
    </AuthLayout>
  );
}
