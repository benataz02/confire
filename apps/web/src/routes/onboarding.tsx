import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Input, Button, MessageStrip, BusyIndicator, CheckBox } from "@ui5/webcomponents-react";
import { authClient, sessionQuery } from "../auth-client.ts";
import { AuthLayout } from "../components/AuthLayout.tsx";
import { orpc, sapGate } from "../orpc.ts";
import {
  apexUrl, BASE_DOMAIN, hardRedirect, isApex, isReserved, SLUG_RE, toSlug, tenantUrl,
} from "../lib/tenant.ts";

export const Route = createFileRoute("/onboarding")({
  // Auth lives on the apex. A user with a company and an agent row belongs *in* the tenant;
  // a company without sap_connection stays here on the agent step.
  beforeLoad: async ({ context }) => {
    if (!isApex()) return hardRedirect(apexUrl("/onboarding"));
    const data = await context.queryClient.ensureQueryData(sessionQuery);
    if (!data?.session) throw redirect({ to: "/login" });
    const org = ((await authClient.organization.list()).data ?? [])[0];
    if (!org) return { agentSetupSlug: null as string | null };
    const gate = await sapGate(context.queryClient);
    if (gate === "setup") return { agentSetupSlug: org.slug };
    return hardRedirect(tenantUrl(org.slug));
  },
  component: Onboarding,
});

type Invite = { id: string; organizationId: string; organizationName: string };

const DEFAULT_AGENT_URL = "http://localhost:4000";
const sanitizeSlug = (v: string) => v.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 31);

function generateAgentSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Visible native input: select it, then copy. Clipboard API is gone on http://lvh.me. */
function copySecret(): boolean {
  const input = document.querySelector<HTMLInputElement>(".auth-secret");
  if (input) {
    input.focus();
    input.select();
    if (document.execCommand("copy")) return true;
  }
  if (window.isSecureContext && navigator.clipboard?.writeText && input) {
    void navigator.clipboard.writeText(input.value);
    return true;
  }
  return false;
}

function Onboarding() {
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

  // Pending invites addressed to this user's email (no mailer needed — they just appear).
  const invites = useQuery({
    queryKey: ["user-invitations"],
    enabled: step === "company",
    queryFn: async () => {
      const res = await authClient.organization.listUserInvitations();
      return ((res.data ?? []) as Array<Invite & { status: string }>).filter((i) => i.status === "pending");
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await authClient.organization.create({ name: company.trim(), slug });
      if (res.error || !res.data) throw new Error(res.error?.message ?? "Could not create company");
    },
    onSuccess: () => setStep("agent"),
  });

  const connect = useMutation(orpc.sap.connect.mutationOptions({
    onSuccess: () => hardRedirect(tenantUrl(slug)),
  }));

  const accept = useMutation({
    mutationFn: async (inv: Invite) => {
      const res = await authClient.organization.acceptInvitation({ invitationId: inv.id });
      if (res.error) throw new Error(res.error.message ?? "Could not accept invitation");
    },
    onSuccess: () => navigate({ to: "/" }), // apex dispatcher routes to the joined workspace
  });

  // The only way off this page without an org: browser-back just re-runs the apex
  // dispatcher, which sends a 0-org user straight back here.
  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    navigate({ to: "/login" });
  };

  const busy = create.isPending || accept.isPending || connect.isPending;
  const error = create.error ?? accept.error ?? connect.error;
  const pending = invites.data ?? [];
  const canCreate = company.trim().length > 0 && available && !busy;
  const canConnect = agentUrl.trim().length > 0 && secret.trim().length > 0 && !busy;
  const errMsg = error instanceof Error ? error.message : error ? String(error) : null;

  if (step === "agent") {
    return (
      <AuthLayout>
        <h2 className="auth-h1">Connect your SAP agent</h2>
        <p className="auth-sub">The cloud reaches B1 through the on-prem agent. Put this secret in agent.json.</p>
        {errMsg ? <MessageStrip design="Negative" hideCloseButton>{errMsg}</MessageStrip> : null}

        <label className="auth-field">
          <span>Agent URL</span>
          <Input
            value={agentUrl}
            placeholder={DEFAULT_AGENT_URL}
            onInput={(e) => setAgentUrl(e.target.value)}
          />
        </label>

        <label className="auth-field">
          <span>Shared secret</span>
          <input
            className="auth-secret"
            value={secret}
            spellCheck={false}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setSecret(e.target.value)}
          />
          <div className="auth-inline">
            <button type="button" className="auth-textbtn" onClick={() => { if (copySecret()) setCopied(true); }}>
              Copy
            </button>
            <button type="button" className="auth-textbtn" onClick={() => { setSecret(generateAgentSecret()); setCopied(false); }}>
              Regenerate
            </button>
          </div>
          <small className="auth-sub">
            {copied ? "Copied. " : ""}Must match <code>secret</code> in the agent’s agent.json.
          </small>
        </label>

        <label className="auth-field">
          <span>Cloudflare Access client ID</span>
          <Input
            value={accessId}
            placeholder="leave empty in local dev"
            onInput={(e) => setAccessId(e.target.value)}
          />
        </label>

        <label className="auth-field">
          <span>Cloudflare Access client secret</span>
          <Input
            type="Password"
            value={accessSecret}
            onInput={(e) => setAccessSecret(e.target.value)}
          />
        </label>

        <CheckBox
          className="auth-check"
          text="Beas is enabled"
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
          {connect.isPending ? "Connecting…" : "Connect agent"}
        </Button>

        <p className="auth-alt">
          Not now? <a href="/login" onClick={(e) => { e.preventDefault(); void signOut(); }}>Sign out</a>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <h2 className="auth-h1">Set up your workspace</h2>
      <p className="auth-sub">Create your company to get started, or join one you were invited to.</p>
      {errMsg ? <MessageStrip design="Negative" hideCloseButton>{errMsg}</MessageStrip> : null}

      {invites.isPending ? <BusyIndicator active /> : null}

      {pending.length > 0 ? (
        <div className="auth-invite-list">
          {pending.map((inv) => (
            <div className="auth-invite" key={inv.id}>
              <span><b>{inv.organizationName}</b><br /><small>You've been invited to join</small></span>
              <Button design="Emphasized" disabled={busy} onClick={() => accept.mutate(inv)}>Join</Button>
            </div>
          ))}
          <div className="auth-or">or create your own</div>
        </div>
      ) : null}

      <label className="auth-field">
        <span>Company name</span>
        <Input
          value={company}
          placeholder="ACME GmbH"
          onInput={(e) => onCompany(e.target.value)}
        />
      </label>

      <label className="auth-field">
        <span>Workspace URL</span>
        <Input
          value={slug}
          placeholder="acme"
          onInput={(e) => { setSlugEdited(true); setSlug(sanitizeSlug(e.target.value)); }}
          onKeyDown={(e) => e.key === "Enter" && canCreate && create.mutate()}
        />
        <small className="auth-sub">
          {slug ? `${slug}.${BASE_DOMAIN}` : `your-company.${BASE_DOMAIN}`}
          {slug && !slugValid ? " · use a-z, 0-9, hyphens" : ""}
          {slugValid && avail.isFetching ? " · checking…" : ""}
          {available ? " · ✓ available" : ""}
          {slugValid && avail.data === false ? " · ✗ taken" : ""}
        </small>
      </label>

      <Button
        design={pending.length > 0 ? "Default" : "Emphasized"}
        disabled={!canCreate}
        onClick={() => create.mutate()}
      >
        {create.isPending ? "Setting up…" : "Create company"}
      </Button>

      <p className="auth-alt">
        Not now? <a href="/login" onClick={(e) => { e.preventDefault(); void signOut(); }}>Sign out</a>
      </p>
    </AuthLayout>
  );
}
