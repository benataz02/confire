import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BusyIndicator, Card, CardHeader, CheckBox, Form, FormItem, Input, Button, Label,
  MessageStrip, FlexBox, Toast, type InputDomRef,
} from "@ui5/webcomponents-react";
import { orpc } from "../../orpc.ts";
import { copyInput, generateAgentSecret } from "../../lib/agent-secret.ts";

export const Route = createFileRoute("/_authed/settings")({ component: Settings });

function Settings() {
  return (
    <div style={{ padding: "1rem", maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <AgentCard />
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
