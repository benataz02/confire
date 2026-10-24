import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Input, Button, MessageStrip, BusyIndicator } from "@ui5/webcomponents-react";
import { authClient, sessionQuery } from "../auth-client.ts";
import { AuthLayout } from "../components/AuthLayout.tsx";
import { PairingCode } from "../components/PairingCode.tsx";
import { lobbyQuery, orpc } from "../orpc.ts";
import { authUrl, currentSlug, hardRedirect, isReserved, tenantUrl } from "@confire/ui/host.ts";
import { useI18n } from "../i18n.ts";

export const Route = createFileRoute("/onboarding")({
  // Outside any workspace. A user with a company and an agent row belongs *in* the tenant;
  // a company without sap_connection stays here on the agent step.
  beforeLoad: async ({ context }) => {
    if (currentSlug()) return hardRedirect(authUrl("/onboarding"));
    const data = await context.queryClient.ensureQueryData(sessionQuery);
    if (!data?.session) throw redirect({ to: "/login" });
    const { workspace } = await context.queryClient.fetchQuery(lobbyQuery);
    if (!workspace) return { agentSetupSlug: null as string | null };
    if (workspace.needsAgent) return { agentSetupSlug: workspace.slug };
    return hardRedirect(workspace.url);
  },
  component: Onboarding,
});

const sanitizeSlug = (v: string) => v.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 31);
/** Clean a company name into a slug candidate (no random suffix — it's the permanent URL). */
const toSlug = (name: string) =>
  name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 30);
const SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;

function Onboarding() {
  const i18n = useI18n();
  const { agentSetupSlug } = Route.useRouteContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<"company" | "agent">(agentSetupSlug ? "agent" : "company");
  const [company, setCompany] = useState("");
  const [slug, setSlug] = useState(agentSetupSlug ?? "");
  const [slugEdited, setSlugEdited] = useState(false);

  const onCompany = (v: string) => {
    setCompany(v);
    if (!slugEdited) setSlug(toSlug(v));
  };

  const slugValid = SLUG_RE.test(slug) && !isReserved(slug);

  // Live availability. ponytail: treat any error as "unavailable" — Better Auth's checkSlug
  // returns ok when free and a 4xx when taken; that's the only signal we need here.
  const avail = useQuery({
    queryKey: ["slug-check", slug],
    enabled: step === "company" && slugValid,
    queryFn: async () => !(await authClient.organization.checkSlug({ slug })).error,
  });
  const available = slugValid && avail.data === true;

  // ponytail: no invitation list — nothing in the app sends one, and Better Auth refuses to list
  //           them for an unverified email, which every password account is until a mailer
  //           exists. Add it back with the member-invite UI.

  const create = useMutation({
    mutationFn: async () => {
      const res = await authClient.organization.create({ name: company.trim(), slug });
      if (res.error || !res.data) throw new Error(res.error?.message ?? i18n.getText("SHELL_AUTH_CREATE_FAILED"));
    },
    onSuccess: () => setStep("agent"),
  });

  // The only way off this page without an org: browser-back just re-runs the dispatcher (/login),
  // which sends a user with no place straight back here.
  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    navigate({ to: "/login" });
  };

  const busy = create.isPending;
  const error = create.error;
  const canCreate = company.trim().length > 0 && available && !busy;
  const errMsg = error instanceof Error ? error.message : error ? String(error) : null;

  if (step === "agent") return <AgentStep slug={slug} signOut={signOut} />;

  return (
    <AuthLayout>
      <h2 className="auth-h1">{i18n.getText("SHELL_AUTH_SETUP_TITLE")}</h2>
      <p className="auth-sub">{i18n.getText("SHELL_AUTH_SETUP_SUB")}</p>
      {errMsg ? <MessageStrip design="Negative" hideCloseButton>{errMsg}</MessageStrip> : null}

      <label className="auth-field">
        <span>{i18n.getText("SHELL_AUTH_COMPANY_NAME")}</span>
        <Input
          value={company}
          placeholder="ACME GmbH"
          onInput={(e) => onCompany(e.target.value)}
        />
      </label>

      <label className="auth-field">
        <span>{i18n.getText("SHELL_AUTH_WORKSPACE_URL")}</span>
        <Input
          value={slug}
          placeholder="acme"
          onInput={(e) => { setSlugEdited(true); setSlug(sanitizeSlug(e.target.value)); }}
          onKeyDown={(e) => e.key === "Enter" && canCreate && create.mutate()}
        />
        <small className="auth-sub">
          {`${window.location.host}/${slug || i18n.getText("SHELL_AUTH_SLUG_EXAMPLE")}`}
          {slug && !slugValid ? ` ${i18n.getText("SHELL_AUTH_SLUG_INVALID")}` : ""}
          {slugValid && avail.isFetching ? ` ${i18n.getText("SHELL_AUTH_SLUG_CHECKING")}` : ""}
          {available ? ` ${i18n.getText("SHELL_AUTH_SLUG_AVAILABLE")}` : ""}
          {slugValid && avail.data === false ? ` ${i18n.getText("SHELL_AUTH_SLUG_TAKEN")}` : ""}
        </small>
      </label>

      <Button
        design="Emphasized"
        disabled={!canCreate}
        onClick={() => create.mutate()}
      >
        {create.isPending ? i18n.getText("SHELL_AUTH_SETTING_UP") : i18n.getText("SHELL_AUTH_CREATE_COMPANY")}
      </Button>

      <p className="auth-alt">
        {i18n.getText("SHELL_AUTH_NOT_NOW")} <a href="/login" onClick={(e) => { e.preventDefault(); void signOut(); }}>{i18n.getText("SHELL_AUTH_SIGN_OUT")}</a>
      </p>
    </AuthLayout>
  );
}

/** Pair the SAP server (spec 2026-10-21 §3): a code on arrival, then wait. The row existing proves
 *  nothing — the page moves on only once SAP answers through the agent. */
function AgentStep({ slug, signOut }: { slug: string; signOut: () => Promise<void> }) {
  const i18n = useI18n();
  const code = useMutation(orpc.sap.onboardingPairingCode.mutationOptions());
  const issue = code.mutate;
  useEffect(() => issue(undefined), [issue]);
  const status = useQuery({ ...orpc.sap.onboardingAgentStatus.queryOptions(), refetchInterval: 3000 });
  const connected = status.data?.connected === true;
  useEffect(() => { if (connected) hardRedirect(tenantUrl(slug)); }, [connected, slug]);

  return (
    <AuthLayout>
      <h2 className="auth-h1">{i18n.getText("SHELL_AUTH_CONNECT_TITLE")}</h2>
      <p className="auth-sub">{i18n.getText("SHELL_AUTH_CONNECT_SUB")}</p>
      {code.error ? <MessageStrip design="Negative" hideCloseButton>{code.error.message}</MessageStrip> : null}
      <PairingCode code={code.data ?? null} busy={code.isPending} onNewCode={() => code.mutate(undefined)} />
      <p className="auth-sub" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        {connected ? i18n.getText("SHELL_AUTH_AGENT_CONNECTED") : <><BusyIndicator active size="S" />{i18n.getText("SHELL_AUTH_AGENT_WAITING")}</>}
      </p>
      {/* A paired agent whose SAP refuses it: say why rather than wait forever. */}
      {status.data?.paired && status.data.error ? <MessageStrip design="Critical" hideCloseButton>{status.data.error}</MessageStrip> : null}
      <p className="auth-alt">
        {i18n.getText("SHELL_AUTH_NOT_NOW")} <a href="/login" onClick={(e) => { e.preventDefault(); void signOut(); }}>{i18n.getText("SHELL_AUTH_SIGN_OUT")}</a>
      </p>
    </AuthLayout>
  );
}
