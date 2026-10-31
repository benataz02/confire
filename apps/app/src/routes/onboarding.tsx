import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon, MessageStrip } from "@ui5/webcomponents-react";
import { AuthCard, AuthChip, AuthField, AuthHead, AuthSteps } from "@confire/ui/auth/AuthLayout.tsx";
import { formatLocale } from "@confire/ui/format.ts";
import { authClient, sessionQuery } from "../auth-client.ts";
import { AuthLayout } from "../components/AuthLayout.tsx";
import { DOWNLOAD, useExpired } from "../components/PairingCode.tsx";
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

  const slugChip = slug && !slugValid ? <AuthChip tone="negative" icon="error">{i18n.getText("SHELL_AUTH_SLUG_INVALID")}</AuthChip>
    : slugValid && avail.isFetching ? <AuthChip tone="neutral">{i18n.getText("SHELL_AUTH_SLUG_CHECKING")}</AuthChip>
    : available ? <AuthChip tone="positive" icon="sys-enter-2">{i18n.getText("SHELL_AUTH_SLUG_AVAILABLE")}</AuthChip>
    : slugValid && avail.data === false ? <AuthChip tone="negative" icon="error">{i18n.getText("SHELL_AUTH_SLUG_TAKEN")}</AuthChip>
    : null;

  return (
    <AuthLayout>
      <SetupSteps current={0} />
      <AuthHead title={i18n.getText("SHELL_AUTH_SETUP_TITLE")} lead={i18n.getText("SHELL_AUTH_SETUP_SUB")} />
      <AuthCard onSubmit={() => canCreate && create.mutate()}>
        {errMsg ? <MessageStrip design="Negative" hideCloseButton>{errMsg}</MessageStrip> : null}
        <AuthField
          label={i18n.getText("SHELL_AUTH_COMPANY_NAME")} name="organization" autoComplete="organization" required
          placeholder="ACME GmbH" value={company} onChange={(e) => onCompany(e.target.value)}
        />
        <AuthField
          label={i18n.getText("SHELL_AUTH_WORKSPACE_URL")} prefix={`${window.location.host}/`} autoComplete="off" spellCheck={false} required
          placeholder={i18n.getText("SHELL_AUTH_SLUG_EXAMPLE")} value={slug}
          onChange={(e) => { setSlugEdited(true); setSlug(sanitizeSlug(e.target.value)); }}
          hint={<><span>{i18n.getText("SHELL_AUTH_SLUG_HINT")}</span>{slugChip}</>}
        />
        <button type="submit" className="auth-btn auth-btn--em" disabled={!canCreate}>
          {create.isPending ? i18n.getText("SHELL_AUTH_SETTING_UP") : i18n.getText("SHELL_AUTH_CREATE_COMPANY")}
        </button>
      </AuthCard>
      <NotNow signOut={signOut} />
    </AuthLayout>
  );
}

function SetupSteps({ current }: { current: number }) {
  const i18n = useI18n();
  return <AuthSteps steps={[i18n.getText("SHELL_AUTH_STEP_COMPANY"), i18n.getText("SHELL_AUTH_STEP_SAP")]} current={current} />;
}

// The only way off this page without an org: browser-back just re-runs the dispatcher (/login),
// which sends a user with no place straight back here.
function NotNow({ signOut }: { signOut: () => Promise<void> }) {
  const i18n = useI18n();
  return (
    <p className="auth-alt">
      {i18n.getText("SHELL_AUTH_NOT_NOW")} <a href="/login" onClick={(e) => { e.preventDefault(); void signOut(); }}>{i18n.getText("SHELL_AUTH_SIGN_OUT")}</a>
    </p>
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
  const expired = useExpired(code.data ?? null);
  // The SAP server is another machine: a copy is for a remote desktop's shared clipboard.
  const [copied, setCopied] = useState(false);
  const copy = () => void navigator.clipboard.writeText(DOWNLOAD).then(() => setCopied(true));

  return (
    <AuthLayout wide>
      <SetupSteps current={1} />
      <AuthHead title={i18n.getText("SHELL_AUTH_CONNECT_TITLE")} lead={i18n.getText("SHELL_AUTH_CONNECT_SUB")} />
      <AuthCard>
        {code.error ? <MessageStrip design="Negative" hideCloseButton>{code.error.message}</MessageStrip> : null}
        {/* A paired agent whose SAP refuses it: say why rather than wait forever. */}
        {status.data?.paired && status.data.error ? <MessageStrip design="Critical" hideCloseButton>{status.data.error}</MessageStrip> : null}
        <ol className="auth-ol">
          <li>
            <div>
              <b>{i18n.getText("ADMIN_PAIR_DOWNLOAD")}</b>
              <div className="auth-dl">
                <Icon name="download" />
                <a href={DOWNLOAD}>{DOWNLOAD}</a>
                <button type="button" className="auth-btn auth-btn--sm" onClick={copy}>
                  <Icon name={copied ? "accept" : "copy"} />{i18n.getText(copied ? "SHELL_AUTH_COPIED" : "SHELL_AUTH_COPY")}
                </button>
              </div>
              <p className="auth-note">{i18n.getText("ADMIN_PAIR_SMARTSCREEN")}</p>
            </div>
          </li>
          <li>
            <div>
              <b>{i18n.getText("ADMIN_PAIR_CODE")}</b>
              <div className="auth-code">
                <code aria-live="polite" className={expired ? "expired" : undefined}>{code.data?.code ?? "····-····"}</code>
                <button type="button" className="auth-btn auth-btn--fit" disabled={code.isPending} onClick={() => code.mutate(undefined)}>
                  <Icon name="refresh" />{i18n.getText("ADMIN_PAIR_NEW_CODE")}
                </button>
              </div>
              {code.data ? (
                <p className="auth-note">{expired ? i18n.getText("ADMIN_PAIR_EXPIRED")
                  : i18n.getText("ADMIN_PAIR_VALID", code.data.expiresAt.toLocaleTimeString(formatLocale(), { hour: "2-digit", minute: "2-digit" }))}</p>
              ) : null}
            </div>
          </li>
        </ol>
        <div className="auth-wait" role="status">
          <span className={connected ? "auth-pulse auth-pulse--done" : "auth-pulse"} />
          {connected ? i18n.getText("SHELL_AUTH_AGENT_CONNECTED") : i18n.getText("SHELL_AUTH_AGENT_WAITING")}
        </div>
      </AuthCard>
      <NotNow signOut={signOut} />
    </AuthLayout>
  );
}
