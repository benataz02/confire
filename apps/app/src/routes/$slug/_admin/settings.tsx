import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BusyIndicator, Card, CardHeader, CheckBox, Form, FormItem, Input, Button, Label,
  MessageStrip, FlexBox, Tab, TabContainer, Toast, type InputDomRef,
} from "@ui5/webcomponents-react";
import { useI18n } from "../../../i18n.ts";
import { orpc } from "../../../orpc.ts";
import { copyInput, generateAgentSecret } from "../../../lib/agent-secret.ts";
import { PortalDocFields } from "../../../components/settings/PortalDocFields.tsx";
import { PortalOnboarding } from "../../../components/settings/PortalOnboarding.tsx";
import { PortalBranding } from "../../../components/settings/PortalBranding.tsx";
import { PortalMail } from "../../../components/settings/PortalMail.tsx";

export const Route = createFileRoute("/$slug/_admin/settings")({ component: Settings });

const PAGE = { padding: "1rem", maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: "1rem" } as const;

/** Admin settings: how Confire reaches SAP, and what the customer portal shows (spec §10). */
function Settings() {
  const i18n = useI18n();
  // A tab's content mounts only while it is selected: the Portal tab reads four SAP schemas.
  const [tab, setTab] = useState("agent");
  return (
    <TabContainer contentBackgroundDesign="Transparent"
      onTabSelect={(e) => setTab((e.detail.tab as HTMLElement).dataset.key ?? "agent")}>
      <Tab text={i18n.getText("ADMIN_TAB_SAP_AGENT")} data-key="agent" selected={tab === "agent"}>
        {tab === "agent" ? <div style={PAGE}><AgentCard /></div> : null}
      </Tab>
      <Tab text={i18n.getText("NAV_PORTAL")} data-key="portal" selected={tab === "portal"}>
        {/* Postgres-only cards first: the last two read SAP and may take a while. */}
        {tab === "portal" ? (
          <div style={PAGE}>
            <PortalBranding /><PortalMail /><PortalDocFields /><PortalOnboarding />
          </div>
        ) : null}
      </Tab>
    </TabContainer>
  );
}

function AgentCard() {
  const i18n = useI18n();
  const agent = useQuery(orpc.sap.agent.queryOptions());
  return (
    <Card header={<CardHeader titleText={i18n.getText("ADMIN_TAB_SAP_AGENT")} subtitleText={i18n.getText("ADMIN_AGENT_SUBTITLE")} />}>
      {agent.data ? <AgentForm current={agent.data} />
        : agent.error ? <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{agent.error.message}</MessageStrip>
        : <BusyIndicator active style={{ margin: "1rem" }} />}
    </Card>
  );
}

/** Seeded once from the server row. Secrets are never sent back, so their fields start empty and
 *  empty means "keep" — the server applies the same rule. */
function AgentForm({ current }: { current: { agentUrl: string; accessClientId: string | null; beasEnabled: boolean } }) {
  const i18n = useI18n();
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
      setToast(i18n.getText("ADMIN_AGENT_SAVED"));
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
        <FormItem labelContent={<Label for="agent-url" required>{i18n.getText("ADMIN_AGENT_URL")}</Label>}>
          <Input id="agent-url" value={agentUrl} placeholder="https://agent.example.com"
            valueState={agentUrl.trim() ? "None" : "Negative"}
            onInput={(e) => setAgentUrl(e.target.value)} />
        </FormItem>
        <FormItem labelContent={<Label for="agent-secret">{i18n.getText("ADMIN_SHARED_SECRET")}</Label>}>
          <FlexBox style={{ gap: "0.5rem", width: "100%" }}>
            <Input id="agent-secret" ref={secretRef} value={secret} placeholder={i18n.getText("ADMIN_UNCHANGED")} style={{ flex: 1 }}
              onInput={(e) => setSecret(e.target.value)} />
            <Button onClick={() => setSecret(generateAgentSecret())}>{i18n.getText("ADMIN_GENERATE")}</Button>
            <Button icon="copy" tooltip={i18n.getText("ADMIN_COPY_SECRET")} accessibleName={i18n.getText("ADMIN_COPY_SECRET")} disabled={!secret}
              onClick={() => { if (copyInput(secretRef.current?.shadowRoot?.querySelector("input"))) setToast(i18n.getText("ADMIN_SECRET_COPIED")); }} />
          </FlexBox>
        </FormItem>
        <FormItem labelContent={<Label for="agent-access-id">{i18n.getText("ADMIN_CF_ACCESS_ID")}</Label>}>
          <Input id="agent-access-id" value={accessId} placeholder={i18n.getText("ADMIN_NONE_LOCAL_DEV")}
            onInput={(e) => setAccessId(e.target.value)} />
        </FormItem>
        <FormItem labelContent={<Label for="agent-access-secret" required={accessIdChanged && !!accessId.trim()}>
          {i18n.getText("ADMIN_CF_ACCESS_SECRET")}</Label>}>
          <Input id="agent-access-secret" type="Password" value={accessSecret} disabled={!accessId.trim()}
            placeholder={accessId.trim() && !accessIdChanged ? i18n.getText("ADMIN_UNCHANGED") : ""}
            valueState={accessSecretMissing ? "Negative" : "None"}
            valueStateMessage={<div>{i18n.getText("ADMIN_NEW_CLIENT_SECRET")}</div>}
            onInput={(e) => setAccessSecret(e.target.value)} />
        </FormItem>
        <FormItem labelContent={<Label>Beas</Label>}>
          <CheckBox text={i18n.getText("ADMIN_BEAS_ENABLED")} checked={beas} onChange={(e) => setBeas(e.target.checked)} />
        </FormItem>
      </Form>
      {secret ? (
        <MessageStrip design="Critical" hideCloseButton>
          {i18n.getText("ADMIN_SECRET_HINT")}
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
        {save.isPending ? i18n.getText("ADMIN_SAVING") : i18n.getText("ADMIN_SAVE")}
      </Button>
      <Toast open={toast !== null} onClose={() => setToast(null)}>{toast}</Toast>
    </FlexBox>
  );
}
