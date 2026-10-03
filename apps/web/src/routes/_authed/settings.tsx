import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, BusyIndicator, Card, CardHeader, CheckBox, Dialog, Form, FormItem, Input, Button, ObjectStatus, Label,
  MessageStrip, FlexBox, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction,
  Text, Toast, type InputDomRef,
} from "@ui5/webcomponents-react";
import { orpc } from "../../orpc.ts";
import { copyInput, generateAgentSecret } from "../../lib/agent-secret.ts";
import { CflField } from "../../shared/cfl/CflField.tsx";
import { cfl } from "../../shared/cfl/cfl-configs.ts";

export const Route = createFileRoute("/_authed/settings")({ component: Settings });

const CUSTOMER = { dialogConfig: cfl.customers() };

function Settings() {
  const qc = useQueryClient();
  const clients = useQuery(orpc.portalClients.list.queryOptions());
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invEmail, setInvEmail] = useState("");
  const [invCardCode, setInvCardCode] = useState("");
  const [acceptUrl, setAcceptUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const invite = useMutation(orpc.portalClients.invite.mutationOptions({
    onSuccess: (r) => {
      setAcceptUrl(`${window.location.origin}/accept?token=${r.token}`);
      qc.invalidateQueries({ queryKey: orpc.portalClients.list.queryOptions().queryKey });
    },
  }));
  const revoke = useMutation(orpc.portalClients.revoke.mutationOptions({
    onSuccess: () => qc.invalidateQueries({ queryKey: orpc.portalClients.list.queryOptions().queryKey }),
  }));

  return (
    <div style={{ padding: "1rem", maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <AgentCard />
      <Card header={<CardHeader titleText="Portal clients" subtitleText="Invite your customers to configure and request quotes" />}>
        <FlexBox direction="Column" style={{ padding: "1rem", gap: "1rem" }}>
          <Button design="Emphasized" style={{ alignSelf: "start" }}
            onClick={() => { setInvEmail(""); setInvCardCode(""); setAcceptUrl(null); setInviteOpen(true); }}>
            Invite client
          </Button>
          {revoke.error ? <MessageStrip design="Negative" hideCloseButton>{revoke.error.message}</MessageStrip> : null}
          <Table
            noDataText="No portal clients yet — invite one."
            rowActionCount={1}
            onRowActionClick={(e) => {
              const id = ((e.detail.row as unknown) as HTMLElement).dataset.id;
              if (id) revoke.mutate({ id });
            }}
            headerRow={
              <TableHeaderRow>
                <TableHeaderCell><span>Email</span></TableHeaderCell>
                <TableHeaderCell><span>Customer</span></TableHeaderCell>
                <TableHeaderCell><span>Status</span></TableHeaderCell>
              </TableHeaderRow>
            }
          >
            {(clients.data ?? []).map((c) => {
              const expired = !c.acceptedAt && Date.now() - new Date(c.invitedAt).getTime() > 7 * 24 * 3600 * 1000;
              const status = c.acceptedAt ? { state: "Positive" as const, text: "Active" }
                : expired ? { state: "Negative" as const, text: "Expired" }
                : { state: "Critical" as const, text: "Invited" };
              return (
                <TableRow key={c.id} rowKey={c.id} data-id={c.id}
                  actions={<TableRowAction icon="delete" text="Revoke" />}>
                  <TableCell><Text>{c.email}</Text></TableCell>
                  <TableCell><Text>{c.cardName} ({c.cardCode})</Text></TableCell>
                  <TableCell><ObjectStatus state={status.state}>{status.text}</ObjectStatus></TableCell>
                </TableRow>
              );
            })}
          </Table>
        </FlexBox>
      </Card>

      <Dialog open={inviteOpen} headerText="Invite portal client" onClose={() => setInviteOpen(false)}
        footer={
          <Bar design="Footer" endContent={
            acceptUrl ? <Button onClick={() => setInviteOpen(false)}>Done</Button> : (
              <>
                <Button design="Emphasized"
                  disabled={!invEmail.trim() || !invCardCode.trim() || invite.isPending}
                  onClick={() => invite.mutate({ email: invEmail.trim(), cardCode: invCardCode.trim() })}>
                  {invite.isPending ? "Creating…" : "Create invite"}
                </Button>
                <Button onClick={() => setInviteOpen(false)}>Cancel</Button>
              </>
            )
          } />
        }
      >
        {acceptUrl ? (
          <FlexBox direction="Column" style={{ gap: "0.5rem", padding: "0.5rem 0" }}>
            <MessageStrip design="Information" hideCloseButton>
              Copy this link and send it to your client — it is shown only once and expires in 7 days.
            </MessageStrip>
            <Input readonly value={acceptUrl} style={{ width: "100%" }} />
            <Button icon="copy" onClick={() => { void navigator.clipboard.writeText(acceptUrl); setCopied(true); }}>
              Copy link
            </Button>
          </FlexBox>
        ) : (
          <FlexBox direction="Column" style={{ gap: "0.5rem", padding: "0.5rem 0" }}>
            {invite.error ? <MessageStrip design="Negative" hideCloseButton>{invite.error.message}</MessageStrip> : null}
            <Label required>Client email</Label>
            <Input type="Email" value={invEmail} onInput={(e) => setInvEmail(e.target.value)} />
            <Label required>Customer</Label>
            {/* The server validates the binding against SAP again on invite; this only helps pick. */}
            <CflField config={CUSTOMER} value={invCardCode} accessibleName="Customer"
              onValueChange={(v) => setInvCardCode(v === null || v === undefined ? "" : String(v))} />
          </FlexBox>
        )}
      </Dialog>
      <Toast open={copied} onClose={() => setCopied(false)}>Invite link copied</Toast>
    </div>
  );
}

function AgentCard() {
  const agent = useQuery(orpc.sap.agent.queryOptions());
  return (
    <Card header={<CardHeader titleText="SAP agent" subtitleText="How Confire reaches SAP Business One on your network" />}>
      {agent.data ? <AgentForm current={agent.data} />
        : agent.error ? <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{agent.error.message}</MessageStrip>
        : <BusyIndicator active style={{ margin: "1rem" }} />}
    </Card>
  );
}

/** Seeded once from the server row. Secrets are never sent back, so their fields start empty and
 *  empty means "keep" — the server applies the same rule. */
function AgentForm({ current }: { current: { agentUrl: string; accessClientId: string | null; beasEnabled: boolean } }) {
  const qc = useQueryClient();
  const [agentUrl, setAgentUrl] = useState(current.agentUrl);
  const [secret, setSecret] = useState("");
  const [accessId, setAccessId] = useState(current.accessClientId ?? "");
  const [accessSecret, setAccessSecret] = useState("");
  const [beas, setBeas] = useState(current.beasEnabled);
  const [toast, setToast] = useState<string | null>(null);
  const secretRef = useRef<InputDomRef>(null);

  const save = useMutation(orpc.sap.reconfigure.mutationOptions({
    onSuccess: () => {
      setSecret("");
      setAccessSecret("");
      setToast("Agent settings saved");
      qc.invalidateQueries({ queryKey: orpc.sap.agent.queryOptions().queryKey });
    },
  }));

  // A different client ID has no stored secret worth keeping — the old one belongs to the old ID.
  const accessIdChanged = accessId.trim() !== (current.accessClientId ?? "");
  const accessSecretMissing = !!accessId.trim() && accessIdChanged && !accessSecret.trim();
  const canSave = !!agentUrl.trim() && !accessSecretMissing && !save.isPending;

  return (
    <FlexBox direction="Column" style={{ padding: "1rem", gap: "1rem" }}>
      {save.error ? <MessageStrip design="Negative" hideCloseButton>{save.error.message}</MessageStrip> : null}
      <Form accessibleMode="Edit" labelSpan="S12 M4 L4 XL4" layout="S1 M1 L1 XL1">
        <FormItem labelContent={<Label for="agent-url" required>Agent URL</Label>}>
          <Input id="agent-url" value={agentUrl} placeholder="https://agent.example.com"
            valueState={agentUrl.trim() ? "None" : "Negative"}
            onInput={(e) => setAgentUrl(e.target.value)} />
        </FormItem>
        <FormItem labelContent={<Label for="agent-secret">Shared secret</Label>}>
          <FlexBox style={{ gap: "0.5rem", width: "100%" }}>
            <Input id="agent-secret" ref={secretRef} value={secret} placeholder="Unchanged" style={{ flex: 1 }}
              onInput={(e) => setSecret(e.target.value)} />
            <Button onClick={() => setSecret(generateAgentSecret())}>Generate</Button>
            <Button icon="copy" tooltip="Copy secret" accessibleName="Copy secret" disabled={!secret}
              onClick={() => { if (copyInput(secretRef.current?.shadowRoot?.querySelector("input"))) setToast("Secret copied"); }} />
          </FlexBox>
        </FormItem>
        <FormItem labelContent={<Label for="agent-access-id">Cloudflare Access client ID</Label>}>
          <Input id="agent-access-id" value={accessId} placeholder="None (local dev)"
            onInput={(e) => setAccessId(e.target.value)} />
        </FormItem>
        <FormItem labelContent={<Label for="agent-access-secret" required={accessIdChanged && !!accessId.trim()}>
          Cloudflare Access client secret</Label>}>
          <Input id="agent-access-secret" type="Password" value={accessSecret} disabled={!accessId.trim()}
            placeholder={accessId.trim() && !accessIdChanged ? "Unchanged" : ""}
            valueState={accessSecretMissing ? "Negative" : "None"}
            valueStateMessage={<div>A new client ID needs its client secret.</div>}
            onInput={(e) => setAccessSecret(e.target.value)} />
        </FormItem>
        <FormItem labelContent={<Label>Beas</Label>}>
          <CheckBox text="Beas is enabled" checked={beas} onChange={(e) => setBeas(e.target.checked)} />
        </FormItem>
      </Form>
      {secret ? (
        <MessageStrip design="Critical" hideCloseButton>
          Put this secret in the agent’s agent.json and restart it. Until both sides match, every SAP call fails.
        </MessageStrip>
      ) : null}
      <Button design="Emphasized" style={{ alignSelf: "start" }} disabled={!canSave}
        onClick={() => save.mutate({
          agentUrl: agentUrl.trim(),
          secret: secret.trim() || undefined,
          accessClientId: accessId.trim() || null,
          accessClientSecret: accessSecret.trim() || undefined,
          beasEnabled: beas,
        })}>
        {save.isPending ? "Saving…" : "Save"}
      </Button>
      <Toast open={toast !== null} onClose={() => setToast(null)}>{toast}</Toast>
    </FlexBox>
  );
}
