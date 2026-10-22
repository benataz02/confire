import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Input, Button, MessageStrip, CheckBox } from "@ui5/webcomponents-react";
import { authClient, sessionQuery } from "../auth-client.ts";
import { AuthLayout } from "../components/AuthLayout.tsx";
import { lobbyQuery, orpc } from "../orpc.ts";
import { authUrl, currentSlug, hardRedirect, isReserved, tenantUrl } from "@confire/ui/host.ts";
import { copyInput, generateAgentSecret } from "../lib/agent-secret.ts";
import { useI18n } from "../i18n.ts";

/** Wrap the JSON key `secret` so the hint stays one sentence in either language. */
function withCode(text: string): ReactNode {
  const word = "secret";
  const at = text.indexOf(word);
  if (at < 0) return text;
  return <>{text.slice(0, at)}<code>{word}</code>{text.slice(at + word.length)}</>;
}

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

const DEFAULT_AGENT_URL = "http://localhost:4000";
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
  const [agentUrl, setAgentUrl] = useState(DEFAULT_AGENT_URL);
  const [secret, setSecret] = useState(generateAgentSecret);
  const [accessId, setAccessId] = useState("");
  const [accessSecret, setAccessSecret] = useState("");
  const [beas, setBeas] = useState(false);
  const [copied, setCopied] = useState(false);

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

  const connect = useMutation(orpc.sap.connect.mutationOptions({
    onSuccess: () => hardRedirect(tenantUrl(slug)),
  }));

  // The only way off this page without an org: browser-back just re-runs the dispatcher (/login),
  // which sends a user with no place straight back here.
  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    navigate({ to: "/login" });
  };

  const busy = create.isPending || connect.isPending;
  const error = create.error ?? connect.error;
  const canCreate = company.trim().length > 0 && available && !busy;
  const canConnect = agentUrl.trim().length > 0 && secret.trim().length > 0 && !busy;
  const errMsg = error instanceof Error ? error.message : error ? String(error) : null;

  if (step === "agent") {
    return (
      <AuthLayout>
        <h2 className="auth-h1">{i18n.getText("SHELL_AUTH_CONNECT_TITLE")}</h2>
        <p className="auth-sub">{i18n.getText("SHELL_AUTH_CONNECT_SUB")}</p>
        {errMsg ? <MessageStrip design="Negative" hideCloseButton>{errMsg}</MessageStrip> : null}

        <label className="auth-field">
          <span>{i18n.getText("SHELL_AUTH_AGENT_URL")}</span>
          <Input
            value={agentUrl}
            placeholder={DEFAULT_AGENT_URL}
            onInput={(e) => setAgentUrl(e.target.value)}
          />
        </label>

        <label className="auth-field">
          <span>{i18n.getText("SHELL_AUTH_SHARED_SECRET")}</span>
          <input
            className="auth-secret"
            value={secret}
            spellCheck={false}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setSecret(e.target.value)}
          />
          <div className="auth-inline">
            <button type="button" className="auth-textbtn" onClick={() => { if (copyInput(document.querySelector<HTMLInputElement>(".auth-secret"))) setCopied(true); }}>
              {i18n.getText("SHELL_AUTH_COPY")}
            </button>
            <button type="button" className="auth-textbtn" onClick={() => { setSecret(generateAgentSecret()); setCopied(false); }}>
              {i18n.getText("SHELL_AUTH_REGENERATE")}
            </button>
          </div>
          <small className="auth-sub">
            {copied ? `${i18n.getText("SHELL_AUTH_COPIED")} ` : ""}
            {withCode(i18n.getText("SHELL_AUTH_SECRET_HINT"))}
          </small>
        </label>

        <label className="auth-field">
          <span>{i18n.getText("SHELL_AUTH_CF_ID")}</span>
          <Input
            value={accessId}
            placeholder={i18n.getText("SHELL_AUTH_CF_ID_PLACEHOLDER")}
            onInput={(e) => setAccessId(e.target.value)}
          />
        </label>

        <label className="auth-field">
          <span>{i18n.getText("SHELL_AUTH_CF_SECRET")}</span>
          <Input
            type="Password"
            value={accessSecret}
            onInput={(e) => setAccessSecret(e.target.value)}
          />
        </label>

        <CheckBox
          className="auth-check"
          text={i18n.getText("SHELL_AUTH_BEAS")}
          checked={beas}
          onChange={(e) => setBeas(e.target.checked)}
        />

        <Button
          design="Emphasized"
          disabled={!canConnect}
          onClick={() => connect.mutate({
            agentUrl: agentUrl.trim(),
            secret: secret.trim(),
            accessClientId: accessId.trim() || null,
            accessClientSecret: accessSecret.trim() || null,
            beasEnabled: beas,
          })}
        >
          {connect.isPending ? i18n.getText("SHELL_AUTH_CONNECTING") : i18n.getText("SHELL_AUTH_CONNECT")}
        </Button>

        <p className="auth-alt">
          {i18n.getText("SHELL_AUTH_NOT_NOW")} <a href="/login" onClick={(e) => { e.preventDefault(); void signOut(); }}>{i18n.getText("SHELL_AUTH_SIGN_OUT")}</a>
        </p>
      </AuthLayout>
    );
  }

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
