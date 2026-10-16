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

// The company page (spec §9): the business partner as the supplier's SAP has it, the colleagues on
// the portal, and the registered email domains. Owner only (the server gates every write too).
export const Route = createFileRoute("/_authed/company")({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (me.company?.role !== "owner") throw redirect({ to: "/" });
  },
  component: Company,
});

const TYPE_LABEL: Record<string, string> = { cCustomer: "Customer", cLid: "Lead" };

function Company() {
  const me = useQuery(meQuery).data as Me & { company: NonNullable<Me["company"]> };
  const qc = useQueryClient();
  const navigate = useNavigate();
  const company = useQuery(orpc.company.get.queryOptions());
  const people = useQuery(orpc.company.members.list.queryOptions());
  const domains = useQuery(orpc.company.domains.list.queryOptions());
  const tenant = me.tenant.name;

  const refresh = () => qc.invalidateQueries({ queryKey: orpc.company.key() });
  // An owner who demotes or removes themselves leaves this page: back home, with `me` re-read.
  const leftIfSelf = async (userId: string) => {
    if (userId !== me.user.id) return;
    await qc.invalidateQueries({ queryKey: meQuery.queryKey });
    void navigate({ to: "/" });
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
      toast(`Invitation sent to ${v.email}`);
      void refresh();
    },
  }));
  const busy = setRole.isPending || remove.isPending || cancelInvite.isPending;
  const domainList = (domains.data ?? []).map((d) => d.domain);

  const removeMember = async (m: PortalMemberRow) => {
    const self = m.userId === me.user.id;
    const ok = await confirm({
      title: self ? "Leave the company" : "Remove colleague",
      message: self
        ? `Leave ${me.company.cardName} on ${tenant}'s portal? You lose access at once.`
        : `Remove ${m.name} (${m.email})? They lose access to ${tenant}'s portal at once.`,
      actionText: self ? "Leave" : "Remove",
      destructive: true,
    });
    if (ok) remove.mutate({ userId: m.userId });
  };

  const s = company.data?.summary;
  const line = (label: string, value: unknown) =>
    value ? <FormItem labelContent={<Label showColon>{label}</Label>}><Text>{String(value)}</Text></FormItem> : null;

  return (
    <ObjectPage
      hidePinButton
      titleArea={
        <ObjectPageTitle
          header={<Title>{company.data?.cardName ?? me.company.cardName}</Title>}
          subHeader={<Text>{[me.company.cardCode, TYPE_LABEL[company.data?.cardType ?? me.company.cardType]].filter(Boolean).join(" · ")}</Text>}
        />
      }
    >
      <ObjectPageSection id="company" titleText="Company">
        {company.data?.summaryError ? (
          <MessageStrip design="Information" hideCloseButton>
            {tenant}'s system can't be reached right now, so only your company's name is shown.
          </MessageStrip>
        ) : null}
        <Form layout="S1 M2 L2 XL2" labelSpan="S12 M4 L4 XL4">
          {line("Name", s?.CardName ?? me.company.cardName)}
          {line("Customer number", me.company.cardCode)}
          {line("Phone", s?.Phone1)}
          {line("Email", s?.EmailAddress)}
          {line("Address", [s?.Address, [s?.ZipCode, s?.City].filter(Boolean).join(" "), s?.Country].filter(Boolean).join(", "))}
        </Form>
      </ObjectPageSection>

      <ObjectPageSection id="people" titleText="People">
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
                tooltip={domainList.length ? undefined : `Ask ${tenant} to register your company's email domain first`}
                onClick={() => { invite.reset(); setInviting(true); }}>
                Invite colleague
              </Button>
            </div>
          } />
        {inviting ? (
          <InviteDialog
            headerText="Invite a colleague"
            intro={<Text>They join {me.company.cardName} on {tenant}'s portal. You can invite addresses on {domainList.join(", ")}.</Text>}
            defaultRole="buyer"
            busy={invite.isPending}
            error={invite.error?.message}
            onSubmit={({ email, role }) => invite.mutate({ email, role })}
            onClose={() => setInviting(false)} />
        ) : null}
      </ObjectPageSection>

      <ObjectPageSection id="domains" titleText="Email domains">
        <Text>
          Colleagues with a verified address on these domains can join on their own, as viewers. {tenant} registers
          them: ask your contact there to add another.
        </Text>
        <List noDataText="No domain registered yet." style={{ marginTop: "0.5rem" }}>
          {domainList.map((d) => <ListItemStandard key={d} icon="email">{d}</ListItemStandard>)}
        </List>
      </ObjectPageSection>
    </ObjectPage>
  );
}
