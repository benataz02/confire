import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Button, FlexBox, MessageStrip, MultiComboBox, MultiComboBoxItem, Option, Select, Table,
  TableCell, TableHeaderCell, TableHeaderRow, TableRow, Text, Title,
} from "@ui5/webcomponents-react";
import { sameState } from "@confire/ui/views.ts";
import { toast } from "@confire/ui/toast.ts";
import { useI18n } from "../../i18n.ts";
import { orpc } from "../../orpc.ts";
import { GeneralCard, type General } from "./PortalBranding.tsx";

// Settings → Portal → mail (spec §12, D22, D27): who on the client's side hears of each project
// event, and who at the supplier gets a request's mail when nobody else resolves. All of it is
// no-reply notification mail.

type TextFn = (key: string, ...args: Array<string | number>) => string;

/** D27's modes, as both this tab and the BP Object Page's override name them. */
const NOTIFY_MODE_KEY: Record<string, string> = {
  buyers: "ADMIN_NOTIFY_BUYERS", creator: "ADMIN_NOTIFY_CREATOR", off: "ADMIN_NOTIFY_OFF",
};
const NOTIFY_MODES = ["buyers", "creator", "off"] as const;

export function notifyModeLabel(t: TextFn, mode: string): string {
  const key = NOTIFY_MODE_KEY[mode];
  return key ? t(key) : mode;
}

const NOTIFY_EVENT_KEY: Record<string, string> = {
  accepted: "ADMIN_NOTIFY_EVENT_ACCEPTED",
  returned: "ADMIN_CHANGES_REQUESTED",
  declined: "ADMIN_NOTIFY_EVENT_DECLINED",
  quoted: "ADMIN_NOTIFY_EVENT_QUOTED",
  comment: "ADMIN_NOTIFY_EVENT_COMMENT",
};

export function notifyEventLabel(t: TextFn, key: string, fallback: string): string {
  const id = NOTIFY_EVENT_KEY[key];
  return id ? t(id) : fallback;
}

const invalidate = (qc: ReturnType<typeof useQueryClient>) =>
  void qc.invalidateQueries({ queryKey: orpc.portalSettings.general.key() });

export function PortalMail() {
  const i18n = useI18n();
  return (
    <GeneralCard title={i18n.getText("ADMIN_EMAIL_NOTIFICATIONS")} subtitle={i18n.getText("ADMIN_EMAIL_NOTIFICATIONS_SUB")}>
      {(current) => <MailForm current={current} />}
    </GeneralCard>
  );
}

type Notify = General["notify"];
type Mode = NonNullable<Notify[keyof Notify]>;
type Draft = { notify: Notify; notifyFallback: string[] };

function MailForm({ current }: { current: General }) {
  const i18n = useI18n();
  const qc = useQueryClient();
  const stored: Draft = {
    notify: Object.fromEntries(current.events.map((e) => [e.key, current.notify[e.key] ?? "buyers"])) as Notify,
    notifyFallback: current.notifyFallback,
  };
  const [draft, setDraft] = useState(stored);
  useEffect(() => setDraft(stored), [current.notify, current.notifyFallback]);
  const save = useMutation(orpc.portalSettings.save.mutationOptions({
    onSuccess: () => { toast(i18n.getText("ADMIN_NOTIFY_SAVED")); invalidate(qc); },
  }));

  return (
    <FlexBox direction="Column" style={{ padding: "1rem", gap: "1rem" }}>
      {save.error ? <MessageStrip design="Negative" hideCloseButton>{save.error.message}</MessageStrip> : null}
      <Title level="H6">{i18n.getText("ADMIN_YOUR_CLIENTS")}</Title>
      <Table accessibleName={i18n.getText("ADMIN_CLIENT_NOTIFY_A11Y")} overflowMode="Popin"
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell minWidth="12rem">{i18n.getText("ADMIN_WHEN_TEAM")}</TableHeaderCell>
            <TableHeaderCell minWidth="14rem">{i18n.getText("ADMIN_MAIL_GOES_TO")}</TableHeaderCell>
          </TableHeaderRow>
        }>
        {current.events.map((e) => {
          const event = notifyEventLabel((k) => i18n.getText(k), e.key, e.label);
          return (
          <TableRow key={e.key} rowKey={e.key}>
            <TableCell><Text>{event}</Text></TableCell>
            <TableCell>
              <Select accessibleName={i18n.getText("ADMIN_NOTIFY_WHO", event)} value={draft.notify[e.key]} style={{ width: "17rem" }}
                onChange={(ev) => {
                  const v = (ev.detail.selectedOption.value ?? "buyers") as Mode;
                  setDraft((d) => ({ ...d, notify: { ...d.notify, [e.key]: v } }));
                }}>
                {NOTIFY_MODES.map((v) => <Option key={v} value={v}>{notifyModeLabel((k) => i18n.getText(k), v)}</Option>)}
              </Select>
            </TableCell>
          </TableRow>
          );
        })}
      </Table>
      <Text style={{ color: "var(--sapContent_LabelColor)" }}>
        {i18n.getText("ADMIN_NOTIFY_VIEWER_NOTE")}
      </Text>

      <Title level="H6">{i18n.getText("ADMIN_YOUR_TEAM")}</Title>
      <Text>
        {i18n.getText("ADMIN_TEAM_HELP")}
      </Text>
      <MultiComboBox accessibleName={i18n.getText("ADMIN_FALLBACK_A11Y")} placeholder={i18n.getText("ADMIN_ADMINS_OWNERS")} style={{ width: "min(32rem, 100%)" }}
        selectedValues={draft.notifyFallback}
        onSelectionChange={(e) => {
          const ids = e.detail.items.map((i) => (i as unknown as { value: string }).value);
          setDraft((d) => ({ ...d, notifyFallback: ids }));
        }}>
        {current.staff.map((m) => (
          <MultiComboBoxItem key={m.userId} value={m.userId} text={m.name} additionalText={m.email} />
        ))}
      </MultiComboBox>

      <Button design="Emphasized" style={{ alignSelf: "start" }} disabled={sameState(draft, stored) || save.isPending}
        onClick={() => save.mutate({ notify: draft.notify, notifyFallback: draft.notifyFallback })}>
        {save.isPending ? i18n.getText("ADMIN_SAVING") : i18n.getText("ADMIN_SAVE")}
      </Button>
    </FlexBox>
  );
}
