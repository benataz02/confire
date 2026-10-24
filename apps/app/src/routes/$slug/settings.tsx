import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  BusyIndicator, Card, CardHeader, Form, FormItem, Button, Label, MessageStrip, FlexBox, ObjectStatus,
  Tab, TabContainer, Text,
} from "@ui5/webcomponents-react";
import { NotificationSettings } from "@confire/ui/notifications/Notifications.tsx";
import { formatLocale } from "@confire/ui/format.ts";
import { useI18n } from "../../i18n.ts";
import { notifications, orpc, useIsAdmin } from "../../orpc.ts";
import { PairingCode } from "../../components/PairingCode.tsx";
import { PortalDocFields } from "../../components/settings/PortalDocFields.tsx";
import { PortalOnboarding } from "../../components/settings/PortalOnboarding.tsx";
import { PortalBranding } from "../../components/settings/PortalBranding.tsx";

const TABS = ["agent", "portal", "notifications"] as const;
type SettingsTab = (typeof TABS)[number];

// Not under _admin: Notifications is every member's own switches (notifications spec §10). The other
// tabs are admin-only here as UX; their procedures are adminProcedure.
export const Route = createFileRoute("/$slug/settings")({
  validateSearch: (s: Record<string, unknown>): { tab?: SettingsTab } => ({
    tab: TABS.includes(s.tab as SettingsTab) ? (s.tab as SettingsTab) : undefined,
  }),
  component: Settings,
});

const PAGE = { padding: "1rem", maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: "1rem" } as const;

/** Settings: how Confire reaches SAP and what the customer portal shows (spec §10), and one's own
 *  notifications. The tab is in the URL, so the bell can open Notifications from anywhere. */
function Settings() {
  const i18n = useI18n();
  const isAdmin = useIsAdmin();
  const navigate = Route.useNavigate();
  const search = Route.useSearch();
  const tab = isAdmin ? (search.tab ?? "agent") : "notifications";
  // A tab's content mounts only while it is selected: the Portal tab reads four SAP schemas.
  return (
    <TabContainer contentBackgroundDesign="Transparent"
      onTabSelect={(e) => void navigate({ search: { tab: (e.detail.tab as HTMLElement).dataset.key as SettingsTab }, replace: true })}>
      {isAdmin ? (
        <>
          <Tab text={i18n.getText("ADMIN_TAB_SAP_AGENT")} data-key="agent" selected={tab === "agent"}>
            {tab === "agent" ? <div style={PAGE}><AgentCard /></div> : null}
          </Tab>
          <Tab text={i18n.getText("NAV_PORTAL")} data-key="portal" selected={tab === "portal"}>
            {/* Postgres-only cards first: the last two read SAP and may take a while. */}
            {tab === "portal" ? (
              <div style={PAGE}>
                <PortalBranding /><PortalDocFields /><PortalOnboarding />
              </div>
            ) : null}
          </Tab>
        </>
      ) : null}
      <Tab text={i18n.getText("NOTIF_MENU")} data-key="notifications" selected={tab === "notifications"}>
        {tab === "notifications" ? (
          <NotificationSettings api={notifications} getText={i18n.getText.bind(i18n)} intro={i18n.getText("NOTIF_PAGE_INTRO")} />
        ) : null}
      </Tab>
    </TabContainer>
  );
}

/** The paired SAP server as Confire sees it now (spec 2026-10-21 §7): reached or not, the agent's
 *  version against the bundled build, what is configured on the box — and a new pairing code, which
 *  is how a server is replaced. Nothing here is edited: SAP settings live on the SAP server. */
function AgentCard() {
  const i18n = useI18n();
  const code = useMutation(orpc.sap.pairingCode.mutationOptions());
  // Polls while a code is on screen, so the card turns green when the new server pairs.
  const status = useQuery({ ...orpc.sap.agentStatus.queryOptions(), refetchInterval: code.data ? 3000 : false });
  const s = status.data;
  // The code is spent once an agent redeems it (or it expires): its row goes, the card drops it.
  const reset = code.reset;
  const wasPending = useRef(false);
  useEffect(() => {
    if (s?.pairingPending) wasPending.current = true;
    else if (s && wasPending.current) { wasPending.current = false; reset(); }
  }, [s, reset]);
  const none = "—";

  return (
    <Card header={<CardHeader titleText={i18n.getText("ADMIN_TAB_SAP_AGENT")} subtitleText={i18n.getText("ADMIN_AGENT_SUBTITLE")}
      action={<Button design="Transparent" icon="refresh" disabled={status.isFetching} onClick={() => void status.refetch()}>
        {i18n.getText("ADMIN_AGENT_CHECK")}</Button>} />}>
      <FlexBox direction="Column" style={{ padding: "1rem", gap: "1rem" }}>
        {!s ? (status.error ? <MessageStrip design="Negative" hideCloseButton>{status.error.message}</MessageStrip> : <BusyIndicator active />)
          : !s.paired ? <MessageStrip design="Information" hideCloseButton>{i18n.getText("ADMIN_AGENT_NOT_PAIRED")}</MessageStrip>
          : (
            <>
              <ObjectStatus state={s.connected ? "Positive" : "Negative"} showDefaultIcon>
                {i18n.getText(s.connected ? "ADMIN_AGENT_CONNECTED" : "ADMIN_AGENT_NOT_CONNECTED")}
              </ObjectStatus>
              {s.error ? <MessageStrip design="Negative" hideCloseButton>{s.error}</MessageStrip> : null}
              {s.updateAvailable ? <MessageStrip design="Information" hideCloseButton>{i18n.getText("ADMIN_AGENT_UPDATE", s.latestVersion ?? "")}</MessageStrip> : null}
              <Form layout="S1 M1 L1 XL1" labelSpan="S12 M4 L4 XL4">
                <FormItem labelContent={<Label>{i18n.getText("ADMIN_AGENT_COMPANY")}</Label>}><Text>{s.companyDb ?? none}</Text></FormItem>
                <FormItem labelContent={<Label>{i18n.getText("ADMIN_AGENT_VERSION")}</Label>}><Text>{s.version ?? none}</Text></FormItem>
                <FormItem labelContent={<Label>SAP B1</Label>}><Text>{s.services?.b1 ? "✓" : none}</Text></FormItem>
                <FormItem labelContent={<Label>Beas</Label>}><Text>{s.services?.beas ? "✓" : none}</Text></FormItem>
                <FormItem labelContent={<Label>{i18n.getText("ADMIN_AGENT_PRINTING")}</Label>}>
                  <Text>{s.services?.print.length ? s.services.print.join(", ") : none}</Text>
                </FormItem>
                <FormItem labelContent={<Label>{i18n.getText("ADMIN_AGENT_LAST_OK")}</Label>}>
                  <Text>{s.lastOkAt ? s.lastOkAt.toLocaleString(formatLocale()) : none}</Text>
                </FormItem>
              </Form>
            </>
          )}
        {code.data || code.isPending ? (
          <>
            <MessageStrip design="Critical" hideCloseButton>{i18n.getText("ADMIN_AGENT_REPLACES")}</MessageStrip>
            <PairingCode code={code.data ?? null} busy={code.isPending} onNewCode={() => code.mutate(undefined)} />
            <FlexBox alignItems="Center" style={{ gap: "0.5rem" }}>
              <BusyIndicator active size="S" /><Text>{i18n.getText("ADMIN_AGENT_WAITING")}</Text>
            </FlexBox>
          </>
        ) : (
          <Button style={{ alignSelf: "start" }} design={s?.paired ? "Default" : "Emphasized"} onClick={() => code.mutate(undefined)}>
            {i18n.getText("ADMIN_AGENT_NEW_PAIRING")}
          </Button>
        )}
        {code.error ? <MessageStrip design="Negative" hideCloseButton>{code.error.message}</MessageStrip> : null}
      </FlexBox>
    </Card>
  );
}
