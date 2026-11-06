import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import {
  BusyIndicator, Button, Card, CardHeader, FlexBox, Form, FormGroup, FormItem, Input, Label, Link, MessageStrip,
  ObjectStatus, Switch, Text,
} from "@ui5/webcomponents-react";
import { formatLocale } from "@confire/ui/format.ts";
import { FORM_LAYOUT } from "@confire/ui/formLayout.ts";
import { toast } from "@confire/ui/toast.ts";
import { useI18n } from "../../i18n.ts";
import { orpc } from "../../orpc.ts";
import { b1Label } from "../AppShell.tsx";

// Settings → Email (document-mail spec §5.2): the workspace's Microsoft 365 mailbox, which the create
// pages' "Notify the client" sends quotations, orders, deliveries and invoices from — so a customer's
// reply reaches the supplier — and per document type the switch's default and the address it sends
// from. Connecting is a full page load to Microsoft and back (the server's /api/mail/microsoft routes);
// it lands here with `?mail=<code>`, which `result` turns into words.

const TYPES = ["Quotations", "Orders", "DeliveryNotes", "Invoices"] as const;
type DocType = (typeof TYPES)[number];
type TypeSettings = Partial<Record<DocType, { notify: boolean; from?: string }>>;

const BODY = { padding: "1rem", gap: "0.75rem" } as const;

/** The connect flow's outcome codes → their strip. `admin`/`denied` also offer the admin-consent link. */
const RESULT: Record<string, { design: "Positive" | "Information" | "Critical" | "Negative"; key: string }> = {
  connected: { design: "Positive", key: "EMAIL_RESULT_CONNECTED" },
  consented: { design: "Information", key: "EMAIL_RESULT_CONSENTED" },
  admin: { design: "Critical", key: "EMAIL_RESULT_ADMIN" },
  denied: { design: "Critical", key: "EMAIL_RESULT_DENIED" },
  expired: { design: "Negative", key: "EMAIL_RESULT_EXPIRED" },
  forbidden: { design: "Negative", key: "EMAIL_RESULT_FORBIDDEN" },
  unavailable: { design: "Negative", key: "EMAIL_UNAVAILABLE" },
  failed: { design: "Negative", key: "EMAIL_RESULT_FAILED" },
};

export function EmailSettings({ result, onResultClose }: { result?: string; onResultClose: () => void }) {
  const i18n = useI18n();
  const qc = useQueryClient();
  const { slug } = useParams({ from: "/$slug" });
  const q = useQuery(orpc.documentMail.settings.queryOptions());
  const refresh = () => void qc.invalidateQueries({ queryKey: orpc.documentMail.key() });
  const disconnect = useMutation(orpc.documentMail.disconnect.mutationOptions({ onSuccess: refresh }));
  const save = useMutation(orpc.documentMail.save.mutationOptions({
    onSuccess: () => { toast(i18n.getText("EMAIL_SAVED")); refresh(); },
  }));
  // A full page load: Microsoft's sign-in, then back here.
  const connect = () => window.location.assign(`/api/mail/microsoft/connect?tenant=${encodeURIComponent(slug)}`);
  const s = q.data;
  const shown = result ? RESULT[result] : undefined;
  // What a quick second edit builds on: the pending save's document, else the stored one.
  const types: TypeSettings = (save.isPending ? save.variables?.types : undefined) ?? s?.settings.types ?? {};
  const setType = (type: DocType, change: { notify?: boolean; from?: string | undefined }) => {
    const cur = types[type] ?? { notify: false };
    const next = { ...cur, ...change };
    if (!next.from) delete next.from;
    save.mutate({ types: { ...types, [type]: next } });
  };
  const consentLink = s ? (
    <Link href={s.adminConsentUrl} target="_blank">{i18n.getText("EMAIL_ADMIN_CONSENT_LINK")}</Link>
  ) : null;

  return (
    <>
      <Card header={<CardHeader titleText={i18n.getText("EMAIL_MAILBOX")} subtitleText={i18n.getText("EMAIL_MAILBOX_SUB")} />}>
        <FlexBox direction="Column" style={BODY}>
          {shown ? (
            <MessageStrip design={shown.design} onClose={onResultClose}>
              {i18n.getText(shown.key)}{" "}
              {result === "admin" || result === "denied" ? consentLink : null}
            </MessageStrip>
          ) : null}
          {q.error ? <MessageStrip design="Negative" hideCloseButton>{q.error.message}</MessageStrip>
            : !s ? <BusyIndicator active />
            : (
              <>
                {!s.available ? <MessageStrip design="Critical" hideCloseButton>{i18n.getText("EMAIL_UNAVAILABLE")}</MessageStrip> : null}
                {s.account ? (
                  <>
                    <ObjectStatus state={s.error ? "Critical" : "Positive"} showDefaultIcon>
                      {i18n.getText("EMAIL_CONNECTED", s.account)}
                    </ObjectStatus>
                    {s.error ? <MessageStrip design="Negative" hideCloseButton>{i18n.getText("EMAIL_TOKEN_ERROR", s.error)}</MessageStrip> : null}
                    <Form layout={FORM_LAYOUT} accessibleMode="Display">
                      <FormGroup>
                        <FormItem labelContent={<Label showColon>{i18n.getText("EMAIL_CONNECTED_BY")}</Label>}>
                          <Text>{s.connectedBy ?? "—"}</Text>
                        </FormItem>
                        <FormItem labelContent={<Label showColon>{i18n.getText("EMAIL_CONNECTED_AT")}</Label>}>
                          <Text>{s.connectedAt ? s.connectedAt.toLocaleString(formatLocale()) : "—"}</Text>
                        </FormItem>
                      </FormGroup>
                    </Form>
                    <FlexBox style={{ gap: "0.5rem" }}>
                      <Button design={s.error ? "Emphasized" : "Default"} disabled={!s.available} onClick={connect}>
                        {i18n.getText("EMAIL_RECONNECT")}
                      </Button>
                      <Button design="Transparent" disabled={disconnect.isPending} onClick={() => disconnect.mutate(undefined)}>
                        {i18n.getText("EMAIL_DISCONNECT")}
                      </Button>
                    </FlexBox>
                  </>
                ) : (
                  <>
                    <Text>{i18n.getText("EMAIL_NOT_CONNECTED")}</Text>
                    {disconnect.isSuccess ? <MessageStrip design="Information" hideCloseButton>{i18n.getText("EMAIL_DISCONNECTED_MYAPPS")}</MessageStrip> : null}
                    <Button style={{ alignSelf: "start" }} design="Emphasized" disabled={!s.available} onClick={connect}>
                      {i18n.getText("EMAIL_CONNECT")}
                    </Button>
                    <Text style={{ color: "var(--sapContent_LabelColor)" }}>{i18n.getText("EMAIL_ADMIN_CONSENT_HINT")} {consentLink}</Text>
                  </>
                )}
                {disconnect.error ? <MessageStrip design="Negative" hideCloseButton>{disconnect.error.message}</MessageStrip> : null}
              </>
            )}
        </FlexBox>
      </Card>
      <Card header={<CardHeader titleText={i18n.getText("EMAIL_TYPES")} subtitleText={i18n.getText("EMAIL_TYPES_SUB")} />}>
        <FlexBox direction="Column" style={BODY}>
          {save.error ? <MessageStrip design="Negative" hideCloseButton>{save.error.message}</MessageStrip> : null}
          {s ? (
            <Form layout={FORM_LAYOUT}>
              {TYPES.map((type) => (
                <FormGroup key={type} headerText={b1Label(type, (k) => i18n.getText(k))}>
                  <FormItem labelContent={<Label>{i18n.getText("NOTIFY_CLIENT")}</Label>}>
                    <Switch checked={!!types[type]?.notify} disabled={save.isPending}
                      accessibleName={`${b1Label(type, (k) => i18n.getText(k))}: ${i18n.getText("NOTIFY_CLIENT")}`}
                      onChange={(e) => setType(type, { notify: e.target.checked })} />
                  </FormItem>
                  <FormItem labelContent={<Label>{i18n.getText("EMAIL_SEND_FROM")}</Label>}>
                    {/* Remounted on a stored change, so a refused address is put back. */}
                    <Input key={types[type]?.from ?? ""} type="Email" value={types[type]?.from ?? ""} placeholder={s.account ?? ""}
                      disabled={save.isPending}
                      onChange={(e) => setType(type, { from: e.target.value.trim() || undefined })} />
                  </FormItem>
                </FormGroup>
              ))}
            </Form>
          ) : null}
          <Text style={{ color: "var(--sapContent_LabelColor)" }}>{i18n.getText("EMAIL_SEND_FROM_HINT")}</Text>
        </FlexBox>
      </Card>
    </>
  );
}
