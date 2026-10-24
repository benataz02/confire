import { useState } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Form, FormItem, Label, List, ListItemStandard, MessageStrip, ObjectPage, ObjectPageSection, ObjectPageTitle,
  Text, Title,
} from "@ui5/webcomponents-react";
import { CompanyPeople, type PortalMemberRow } from "@confire/ui/portal/CompanyPeople.tsx";
import { InviteDialog } from "@confire/ui/portal/InviteDialog.tsx";
import { confirm } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";
import { meQuery, orpc, type Me } from "../../orpc.ts";
import { useI18n } from "../../i18n.ts";

// The company page (spec §9): the business partner as the supplier's SAP has it, the colleagues on
// the portal, and the registered email domains. Owner only (the server gates every write too).
export const Route = createFileRoute("/$slug/company")({
  beforeLoad: async ({ context, params }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (me.company?.role !== "owner") throw redirect({ to: "/$slug", params });
  },
  component: Company,
});

const TYPE_KEY: Record<string, string> = { cCustomer: "PORTAL_BP_CUSTOMER", cLid: "PORTAL_BP_LEAD" };

function Company() {
  const i18n = useI18n();
  const me = useQuery(meQuery).data as Me & { company: NonNullable<Me["company"]> };
  const qc = useQueryClient();
  const navigate = useNavigate({ from: "/$slug" });
  const company = useQuery(orpc.company.get.queryOptions());
  const people = useQuery(orpc.company.members.list.queryOptions());
  const domains = useQuery(orpc.company.domains.list.queryOptions());
  const tenant = me.tenant.name;

  const refresh = () => qc.invalidateQueries({ queryKey: orpc.company.key() });
  // An owner who demotes or removes themselves leaves this page: back home, with `me` re-read.
  const leftIfSelf = async (userId: string) => {
    if (userId !== me.user.id) return;
    await qc.invalidateQueries({ queryKey: meQuery.queryKey });
    void navigate({ to: "/$slug" });
  };
  // The last edit's refusal only: each new edit clears it.
  const [failed, setFailed] = useState<Error | null>(null);
  const opts = { onMutate: () => setFailed(null), onError: (e: Error) => setFailed(e), onSettled: refresh };
  const setRole = useMutation(orpc.company.members.setRole.mutationOptions({ ...opts, onSuccess: (_r, v) => leftIfSelf(v.userId) }));
  const remove = useMutation(orpc.company.members.remove.mutationOptions({ ...opts, onSuccess: (_r, v) => leftIfSelf(v.userId) }));
  const cancelInvite = useMutation(orpc.company.members.cancelInvite.mutationOptions(opts));
  const [inviting, setInviting] = useState(false);
  const invite = useMutation(orpc.company.members.invite.mutationOptions({
    onSuccess: (_r, v) => {
      setInviting(false);
      toast(i18n.getText("PORTAL_INVITE_SENT", v.email));
      void refresh();
    },
  }));
  const busy = setRole.isPending || remove.isPending || cancelInvite.isPending;
  const domainList = (domains.data ?? []).map((d) => d.domain);

  const removeMember = async (m: PortalMemberRow) => {
    const self = m.userId === me.user.id;
    const ok = await confirm({
      title: i18n.getText(self ? "PORTAL_LEAVE_TITLE" : "PORTAL_REMOVE_TITLE"),
      message: self
        ? i18n.getText("PORTAL_LEAVE_MESSAGE", me.company.cardName, tenant)
        : i18n.getText("PORTAL_REMOVE_MESSAGE", m.name, m.email, tenant),
      actionText: i18n.getText(self ? "PORTAL_LEAVE" : "PORTAL_REMOVE"),
      destructive: true,
    });
    if (ok) remove.mutate({ userId: m.userId });
  };

  const s = company.data?.summary;
  const cardType = company.data?.cardType ?? me.company.cardType;
  const typeLabel = TYPE_KEY[cardType] ? i18n.getText(TYPE_KEY[cardType]) : undefined;
  const line = (label: string, value: unknown) =>
    value ? <FormItem labelContent={<Label showColon>{label}</Label>}><Text>{String(value)}</Text></FormItem> : null;

  return (
    <ObjectPage
      hidePinButton
      titleArea={
        <ObjectPageTitle
          header={<Title>{company.data?.cardName ?? me.company.cardName}</Title>}
          subHeader={<Text>{[me.company.cardCode, typeLabel].filter(Boolean).join(" · ")}</Text>}
        />
      }
    >
      <ObjectPageSection id="company" titleText={i18n.getText("PORTAL_COMPANY")}>
        {company.data?.summaryError ? (
          <MessageStrip design="Information" hideCloseButton>
            {i18n.getText("PORTAL_COMPANY_UNREACHABLE", tenant)}
          </MessageStrip>
        ) : null}
        <Form layout="S1 M2 L2 XL2" labelSpan="S12 M4 L4 XL4">
          {line(i18n.getText("PORTAL_NAME"), s?.CardName ?? me.company.cardName)}
          {line(i18n.getText("PORTAL_CUSTOMER_NUMBER"), me.company.cardCode)}
          {line(i18n.getText("PORTAL_PHONE"), s?.Phone1)}
          {line(i18n.getText("PORTAL_EMAIL"), s?.EmailAddress)}
          {line(i18n.getText("PORTAL_ADDRESS"), [s?.Address, [s?.ZipCode, s?.City].filter(Boolean).join(" "), s?.Country].filter(Boolean).join(", "))}
        </Form>
      </ObjectPageSection>

      <ObjectPageSection id="people" titleText={i18n.getText("PORTAL_PEOPLE")}>
        {failed ? <MessageStrip design="Negative" hideCloseButton>{failed.message}</MessageStrip> : null}
        {people.error ? <MessageStrip design="Negative" hideCloseButton>{people.error.message}</MessageStrip> : null}
        {/* Remounted on every refetch: a refused role change leaves UI5's Select showing the value
            that was picked, and identical data would not re-render it. */}
        <CompanyPeople key={people.dataUpdatedAt} members={people.data?.members ?? []} invitations={people.data?.invitations ?? []}
          selfId={me.user.id} busy={busy}
          onSetRole={(m, role) => setRole.mutate({ userId: m.userId, role })}
          onRemove={(m) => void removeMember(m)}
          onCancelInvite={(i) => cancelInvite.mutate({ id: i.id })}
          toolbar={
            <div>
              <Button icon="add-employee" design="Emphasized" disabled={!domainList.length}
                tooltip={domainList.length ? undefined : i18n.getText("PORTAL_INVITE_NEEDS_DOMAIN", tenant)}
                onClick={() => { invite.reset(); setInviting(true); }}>
                {i18n.getText("PORTAL_INVITE")}
              </Button>
            </div>
          } />
        {inviting ? (
          <InviteDialog
            headerText={i18n.getText("PORTAL_INVITE_TITLE")}
            intro={<Text>{i18n.getText("PORTAL_INVITE_INTRO", me.company.cardName, tenant, domainList.join(", "))}</Text>}
            defaultRole="buyer"
            busy={invite.isPending}
            error={invite.error?.message}
            onSubmit={({ email, role }) => invite.mutate({ email, role })}
            onClose={() => setInviting(false)} />
        ) : null}
      </ObjectPageSection>

      <ObjectPageSection id="domains" titleText={i18n.getText("PORTAL_DOMAINS")}>
        <Text>{i18n.getText("PORTAL_DOMAINS_HELP", tenant)}</Text>
        <List noDataText={i18n.getText("PORTAL_DOMAINS_EMPTY")} style={{ marginTop: "0.5rem" }}>
          {domainList.map((d) => <ListItemStandard key={d} icon="email">{d}</ListItemStandard>)}
        </List>
      </ObjectPageSection>
    </ObjectPage>
  );
}
