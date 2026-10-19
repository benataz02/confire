import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Button, FlexBox, Input, Label, MessageStrip, MultiComboBox, MultiComboBoxItem, ObjectStatus, Option, Select, Table,
  TableCell, TableHeaderCell, TableHeaderRow, TableRow, Text, Title,
} from "@ui5/webcomponents-react";
import { sameState } from "@confire/ui/views.ts";
import { toast } from "@confire/ui/toast.ts";
import { confirm } from "@confire/ui/confirm.ts";
import { orpc } from "../../orpc.ts";
import { GeneralCard, type General } from "./PortalBranding.tsx";

// Settings → Portal → mail (spec §12, D22, D27, D29): who on the client's side hears of each project
// event, who at the supplier gets a request's mail when nobody else resolves, where client replies
// go, and the tenant's own sending domain.

/** D27's modes, as both this tab and the BP Object Page's override name them. */
export const NOTIFY_MODE_LABEL: Record<string, string> = {
  buyers: "Creator, buyers and owners", creator: "Project creator only", off: "Nobody",
};

const invalidate = (qc: ReturnType<typeof useQueryClient>) =>
  void qc.invalidateQueries({ queryKey: orpc.portalSettings.general.key() });

export function PortalMail() {
  return (
    <GeneralCard title="Email notifications" subtitle="Who hears about a project, on your side and your client's">
      {(current) => <MailForm current={current} />}
    </GeneralCard>
  );
}

type Notify = General["notify"];
type Mode = NonNullable<Notify[keyof Notify]>;
type Draft = { notify: Notify; notifyFallback: string[]; replyTo: string };

function MailForm({ current }: { current: General }) {
  const qc = useQueryClient();
  const stored: Draft = {
    notify: Object.fromEntries(current.events.map((e) => [e.key, current.notify[e.key] ?? "buyers"])) as Notify,
    notifyFallback: current.notifyFallback,
    replyTo: current.replyTo ?? "",
  };
  const [draft, setDraft] = useState(stored);
  useEffect(() => setDraft(stored), [current.notify, current.notifyFallback, current.replyTo]);
  const save = useMutation(orpc.portalSettings.save.mutationOptions({
    onSuccess: () => { toast("Notification settings saved"); invalidate(qc); },
  }));
  const replyBad = draft.replyTo !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.replyTo);

  return (
    <FlexBox direction="Column" style={{ padding: "1rem", gap: "1rem" }}>
      {save.error ? <MessageStrip design="Negative" hideCloseButton>{save.error.message}</MessageStrip> : null}
      <Title level="H6">Your clients</Title>
      <Table accessibleName="Client email notifications" overflowMode="Popin"
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell minWidth="12rem">When your team…</TableHeaderCell>
            <TableHeaderCell minWidth="14rem">Mail goes to</TableHeaderCell>
          </TableHeaderRow>
        }>
        {current.events.map((e) => (
          <TableRow key={e.key} rowKey={e.key}>
            <TableCell><Text>{e.label}</Text></TableCell>
            <TableCell>
              <Select accessibleName={`${e.label}: who gets mail`} value={draft.notify[e.key]} style={{ width: "17rem" }}
                onChange={(ev) => {
                  const v = (ev.detail.selectedOption.value ?? "buyers") as Mode;
                  setDraft((d) => ({ ...d, notify: { ...d.notify, [e.key]: v } }));
                }}>
                {Object.entries(NOTIFY_MODE_LABEL).map(([v, l]) => <Option key={v} value={v}>{l}</Option>)}
              </Select>
            </TableCell>
          </TableRow>
        ))}
      </Table>
      <Text style={{ color: "var(--sapContent_LabelColor)" }}>
        A viewer only hears about projects they created. Each business partner can override this on its Portal section.
      </Text>

      <FlexBox direction="Column" style={{ gap: "0.25rem" }}>
        <Label for="reply-to" showColon>Client replies go to</Label>
        <Input id="reply-to" type="Email" value={draft.replyTo} placeholder="The person who acted" style={{ width: "min(24rem, 100%)" }}
          valueState={replyBad ? "Negative" : "None"} valueStateMessage={<div>An email address such as sales@your-company.com</div>}
          onInput={(e) => setDraft((d) => ({ ...d, replyTo: e.target.value.trim() }))} />
      </FlexBox>

      <Title level="H6">Your team</Title>
      <Text>
        A client's request mail goes to its assignee once accepted, before that to the business partner's sales employee in
        SAP (when their email belongs to someone here). If neither applies, it goes to these people, or to every admin
        and owner when the list is empty.
      </Text>
      <MultiComboBox accessibleName="Request mail fallback" placeholder="Admins and owners" style={{ width: "min(32rem, 100%)" }}
        selectedValues={draft.notifyFallback}
        onSelectionChange={(e) => {
          const ids = e.detail.items.map((i) => (i as unknown as { value: string }).value);
          setDraft((d) => ({ ...d, notifyFallback: ids }));
        }}>
        {current.staff.map((m) => (
          <MultiComboBoxItem key={m.userId} value={m.userId} text={m.name} additionalText={m.email} />
        ))}
      </MultiComboBox>

      <Button design="Emphasized" style={{ alignSelf: "start" }} disabled={sameState(draft, stored) || replyBad || save.isPending}
        onClick={() => save.mutate({
          notify: draft.notify, notifyFallback: draft.notifyFallback,
          replyTo: draft.replyTo || null,
        })}>
        {save.isPending ? "Saving…" : "Save"}
      </Button>
    </FlexBox>
  );
}

const REGION_LABEL: Record<string, string> = {
  "eu-west-1": "EU (Ireland)", "us-east-1": "US East (N. Virginia)", "sa-east-1": "South America (São Paulo)",
  "ap-northeast-1": "Asia Pacific (Tokyo)",
};
const STATUS: Record<string, { text: string; state: "Positive" | "Negative" | "Information" | "Critical" | "None" }> = {
  verified: { text: "Verified", state: "Positive" },
  failed: { text: "Failed", state: "Negative" },
  partially_failed: { text: "Partly failed", state: "Negative" },
  partially_verified: { text: "Partly verified", state: "Critical" },
  pending: { text: "Checking DNS", state: "Information" },
  not_started: { text: "Waiting for DNS records", state: "None" },
};

export function PortalSenderDomain() {
  return (
    <GeneralCard title="Sender domain" subtitle="Send client mail from your own domain">
      {(current) => <SenderDomain current={current} />}
    </GeneralCard>
  );
}

function SenderDomain({ current }: { current: General }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [region, setRegion] = useState<string>("eu-west-1");
  const opts = { onSuccess: () => invalidate(qc) };
  const add = useMutation(orpc.portalSettings.senderDomain.add.mutationOptions({ ...opts, onSuccess: () => { setName(""); invalidate(qc); } }));
  const verify = useMutation(orpc.portalSettings.senderDomain.verify.mutationOptions(opts));
  const remove = useMutation(orpc.portalSettings.senderDomain.remove.mutationOptions(opts));
  const error = add.error ?? verify.error ?? remove.error;
  const busy = add.isPending || verify.isPending || remove.isPending;
  const d = current.senderDomain;

  if (!current.senderDomains.enabled && !d) {
    return <MessageStrip design="Information" hideCloseButton style={{ margin: "1rem" }}>Sender domains are not available on this server.</MessageStrip>;
  }
  return (
    <FlexBox direction="Column" style={{ padding: "1rem", gap: "1rem" }}>
      {error ? <MessageStrip design="Negative" hideCloseButton>{error.message}</MessageStrip> : null}
      {!d ? (
        <>
          <Text>
            Invitations and project mail go out from Confire's own address until you add a subdomain of yours, such as
            mail.your-company.com. Use a subdomain, never your main domain: its records then can't clash with your own email.
          </Text>
          <FlexBox style={{ gap: "0.5rem", flexWrap: "wrap" }}>
            <Input value={name} placeholder="mail.your-company.com" accessibleName="Sender subdomain" style={{ width: "18rem" }}
              onInput={(e) => setName(e.target.value.trim().toLowerCase())} />
            <Select accessibleName="Region" value={region} onChange={(e) => setRegion(e.detail.selectedOption.value ?? "eu-west-1")}>
              {current.senderDomains.regions.map((r) => <Option key={r} value={r}>{REGION_LABEL[r] ?? r}</Option>)}
            </Select>
            <Button icon="add" disabled={!name || busy}
              onClick={() => add.mutate({ name, region: region as (typeof current.senderDomains.regions)[number] })}>Add</Button>
          </FlexBox>
          <Text style={{ color: "var(--sapContent_LabelColor)" }}>The region is where the mail is sent from, and can't be changed later.</Text>
        </>
      ) : (
        <>
          <FlexBox style={{ gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
            <Title level="H5">{d.name}</Title>
            <ObjectStatus state={STATUS[d.status]?.state ?? "None"} showDefaultIcon>{STATUS[d.status]?.text ?? d.status}</ObjectStatus>
            <Text style={{ color: "var(--sapContent_LabelColor)" }}>{REGION_LABEL[d.region] ?? d.region}</Text>
          </FlexBox>
          {d.error ? <MessageStrip design="Critical" hideCloseButton>{`Resend: ${d.error}`}</MessageStrip> : null}
          <Text>
            {d.status === "verified"
              ? `Client mail comes from notify@${d.name}. If its DNS records go missing, mail goes out from Confire's address instead and this page says why.`
              : "Add these records at your DNS provider, then choose Verify. Until it is verified, client mail comes from Confire's address."}
          </Text>
          <Table accessibleName="DNS records" overflowMode="Popin"
            headerRow={
              <TableHeaderRow>
                <TableHeaderCell width="5rem">Type</TableHeaderCell>
                <TableHeaderCell minWidth="10rem">Name</TableHeaderCell>
                <TableHeaderCell minWidth="16rem">Value</TableHeaderCell>
                <TableHeaderCell width="5rem">Priority</TableHeaderCell>
                <TableHeaderCell width="8rem">Status</TableHeaderCell>
              </TableHeaderRow>
            }>
            {d.records.map((r) => (
              <TableRow key={`${r.type}:${r.name}:${r.record}`} rowKey={`${r.type}:${r.name}:${r.record}`}>
                <TableCell><Text>{r.type}</Text></TableCell>
                <TableCell><Text style={{ wordBreak: "break-all" }}>{r.name}</Text></TableCell>
                <TableCell><Text style={{ wordBreak: "break-all", fontFamily: "var(--sapFontFamily_Monospace, monospace)" }}>{r.value}</Text></TableCell>
                <TableCell><Text>{r.priority ?? ""}</Text></TableCell>
                <TableCell>
                  <ObjectStatus state={STATUS[r.status]?.state ?? "None"}>{STATUS[r.status]?.text ?? r.status}</ObjectStatus>
                </TableCell>
              </TableRow>
            ))}
          </Table>
          <FlexBox style={{ gap: "0.5rem" }}>
            <Button design="Emphasized" icon="refresh" disabled={busy || !current.senderDomains.enabled} onClick={() => verify.mutate({})}>
              {verify.isPending ? "Checking…" : "Verify"}
            </Button>
            <Button design="Transparent" icon="delete" disabled={busy || !current.senderDomains.enabled}
              onClick={async () => {
                if (await confirm({
                  title: "Remove sender domain",
                  message: `Remove ${d.name}? Client mail goes out from Confire's address again, and the domain is removed from Resend.`,
                  actionText: "Remove", destructive: true,
                })) remove.mutate({});
              }}>
              Remove
            </Button>
          </FlexBox>
        </>
      )}
    </FlexBox>
  );
}
