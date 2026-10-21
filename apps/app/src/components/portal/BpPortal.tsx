import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BusyIndicator, Button, FlexBox, Input, Label, MessageStrip, Option, Select, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow,
  TableRowAction, Text,
} from "@ui5/webcomponents-react";
import { orpc } from "../../orpc.ts";
import { NOTIFY_MODE_LABEL } from "../settings/PortalMail.tsx";
import { CompanyPeople } from "@confire/ui/portal/CompanyPeople.tsx";
import { InviteDialog } from "@confire/ui/portal/InviteDialog.tsx";
import { confirm } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";
import { formatValue } from "@confire/ui/format.ts";

// The customer portal on a business partner's Object Page (spec §5.1, §10): the *Invite to portal*
// header action and the Portal section. Both read portalCompanies.get for the CardCode, so an
// invitation sent from the header shows up in the section at once. Admin-only on the server, as is
// the Object Page itself.

const companyQuery = (cardCode: string) => orpc.portalCompanies.get.queryOptions({ input: { cardCode } });

/** Everything an edit here can change: this BP's company, and the tenant's invitation list. */
function useRefresh(cardCode: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: orpc.portalCompanies.get.key({ input: { cardCode } }) });
    void qc.invalidateQueries({ queryKey: orpc.portalInvitations.rows.key() });
  };
}

export function InviteToPortal({ cardCode, cardName }: { cardCode: string; cardName: string }) {
  const [open, setOpen] = useState(false);
  const company = useQuery(companyQuery(cardCode));
  const refresh = useRefresh(cardCode);
  const invite = useMutation(orpc.portalInvitations.inviteExisting.mutationOptions({
    onSuccess: (_r, v) => {
      refresh();
      setOpen(false);
      toast(`Invitation sent to ${v.email}`);
    },
  }));
  // The first person in becomes its owner by default (spec §5.1): someone has to invite the rest.
  const first = !company.data?.members.length;
  return (
    <>
      <Button icon="paper-plane" disabled={company.isPending} onClick={() => { invite.reset(); setOpen(true); }}>
        Invite to portal
      </Button>
      {open ? (
        <InviteDialog
          headerText="Invite to portal"
          intro={<Text>{first
            ? `Nobody from ${cardName} is on your customer portal yet. The first person is usually its owner: they can invite their colleagues.`
            : `They join ${cardName} on your customer portal.`}</Text>}
          defaultRole={first ? "owner" : "buyer"}
          registerDomainFor={cardName}
          busy={invite.isPending}
          error={invite.error?.message}
          onSubmit={(v) => invite.mutate({ cardCode, ...v })}
          onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

/** *Invite new client* (spec §5.1, D25), from the BP List Report header: no CardCode yet. The
 *  invitee fills the onboarding form, whose submit creates the lead in SAP; they are its owner. */
export function InviteNewClientDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const invite = useMutation(orpc.portalInvitations.inviteNew.mutationOptions({
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: orpc.portalInvitations.rows.key() });
      onClose();
      toast(`Invitation sent to ${v.email}`);
    },
  }));
  return (
    <InviteDialog
      headerText="Invite new client"
      intro={<Text>They fill in their company's details on your customer portal. Submitting creates a lead in SAP, and they become its owner on the portal.</Text>}
      registerDomainFor="their company"
      busy={invite.isPending}
      error={invite.error?.message}
      onSubmit={({ email, registerDomain }) => invite.mutate({ email, registerDomain })}
      onClose={onClose} />
  );
}

const rowKeyOf = (row: unknown) => (row as { rowKey: string }).rowKey;

export function BpPortalSection({ cardCode, cardName }: { cardCode: string; cardName: string }) {
  const q = useQuery(companyQuery(cardCode));
  const refresh = useRefresh(cardCode);
  // The last edit's refusal only: each new edit clears it. onSettled, not onSuccess: a refused role
  // change still has to put the role picker back.
  const [failed, setFailed] = useState<Error | null>(null);
  const opts = { onMutate: () => setFailed(null), onError: (e: Error) => setFailed(e), onSettled: refresh };
  const setRole = useMutation(orpc.portalCompanies.setRole.mutationOptions(opts));
  const removeMember = useMutation(orpc.portalCompanies.removeMember.mutationOptions(opts));
  const cancel = useMutation(orpc.portalInvitations.cancel.mutationOptions(opts));
  const [domain, setDomain] = useState("");
  const addDomain = useMutation(orpc.portalCompanies.addDomain.mutationOptions({ ...opts, onSuccess: () => setDomain("") }));
  const removeDomain = useMutation(orpc.portalCompanies.removeDomain.mutationOptions(opts));
  const setNotify = useMutation(orpc.portalCompanies.setNotify.mutationOptions(opts));
  const busy = [setRole, removeMember, cancel, addDomain, removeDomain, setNotify].some((m) => m.isPending);
  const error = q.error ?? failed;

  if (q.isPending) return <BusyIndicator active delay={0} />;
  const d = q.data;
  return (
    <FlexBox direction="Column" style={{ gap: "1rem", width: "100%" }}>
      {error ? <MessageStrip design="Negative" hideCloseButton>{error.message}</MessageStrip> : null}
      {!d?.company ? (
        <MessageStrip design="Information" hideCloseButton>
          Nobody from {cardName} is on your customer portal yet. Use Invite to portal to send the first invitation.
        </MessageStrip>
      ) : (
        <>
          {/* Remounted on every refetch: a refused role change leaves UI5's Select showing the
              value that was picked, and identical data would not re-render it. */}
          <CompanyPeople key={q.dataUpdatedAt} members={d.members} invitations={d.invitations} busy={busy}
            onSetRole={(m, role) => setRole.mutate({ cardCode, userId: m.userId, role })}
            onRemove={async (m) => {
              if (await confirm({ title: "Remove from portal", message: `Remove ${m.name} (${m.email}) from ${cardName}? They lose access at once.`, actionText: "Remove", destructive: true }))
                removeMember.mutate({ cardCode, userId: m.userId });
            }}
            onCancelInvite={async (i) => {
              if (await confirm({ title: "Cancel invitation", message: `Cancel the invitation to ${i.email}? Its link stops working.`, actionText: "Cancel invitation", destructive: true }))
                cancel.mutate({ ids: [i.id] });
            }} />
          <FlexBox direction="Column" style={{ gap: "0.5rem" }}>
            <Label showColon>Registered email domains</Label>
            <Text>A verified sign-in on one of these domains joins {cardName} as viewer, without an invitation.</Text>
            <Table accessibleName="Registered email domains" overflowMode="Popin" noDataText="No domain registered."
              rowActionCount={1}
              onRowActionClick={(e) => {
                const name = rowKeyOf(e.detail.row);
                if (!busy) removeDomain.mutate({ cardCode, domain: name });
              }}
              headerRow={
                <TableHeaderRow>
                  <TableHeaderCell minWidth="12rem">Domain</TableHeaderCell>
                  <TableHeaderCell width="8rem">Added</TableHeaderCell>
                </TableHeaderRow>
              }>
              {d.domains.map((x) => (
                <TableRow key={x.domain} rowKey={x.domain} actions={<TableRowAction icon="delete" text="Remove domain" />}>
                  <TableCell><Text>{x.domain}</Text></TableCell>
                  <TableCell><Text>{formatValue(x.addedAt, "date")}</Text></TableCell>
                </TableRow>
              ))}
            </Table>
            {d.notify ? (
              <FlexBox direction="Column" style={{ gap: "0.5rem" }}>
                <Label showColon>Email notifications</Label>
                <Text>Who at {cardName} hears about their projects. The tenant default is Settings → Portal's.</Text>
                <Table accessibleName="Email notifications" overflowMode="Popin"
                  headerRow={<TableHeaderRow><TableHeaderCell minWidth="12rem">When your team…</TableHeaderCell><TableHeaderCell minWidth="14rem">Mail goes to</TableHeaderCell></TableHeaderRow>}>
                  {d.notify.events.map((e) => (
                    <TableRow key={e.key} rowKey={e.key}>
                      <TableCell><Text>{e.label}</Text></TableCell>
                      <TableCell>
                        <Select accessibleName={`${e.label}: who gets mail`} disabled={busy} style={{ width: "19rem" }} value={d.notify!.company[e.key] ?? ""}
                          onChange={(ev) => {
                            const v = ev.detail.selectedOption.value ?? "";
                            const { [e.key]: _old, ...rest } = d.notify!.company;
                            setNotify.mutate({ cardCode, notify: v ? { ...rest, [e.key]: v as "off" } : rest });
                          }}>
                          <Option value="">{`Tenant default (${NOTIFY_MODE_LABEL[d.notify!.tenant[e.key] ?? "buyers"]})`}</Option>
                          {Object.entries(NOTIFY_MODE_LABEL).map(([v, l]) => <Option key={v} value={v}>{l}</Option>)}
                        </Select>
                      </TableCell>
                    </TableRow>
                  ))}
                </Table>
              </FlexBox>
            ) : null}
            <FlexBox style={{ gap: "0.5rem" }}>
              <Input value={domain} placeholder="kunde.de" accessibleName="Domain to register" style={{ width: "16rem" }}
                onInput={(e) => setDomain(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && domain.trim() && addDomain.mutate({ cardCode, domain })} />
              <Button icon="add" disabled={!domain.trim() || busy} onClick={() => addDomain.mutate({ cardCode, domain })}>
                Register domain
              </Button>
            </FlexBox>
          </FlexBox>
        </>
      )}
    </FlexBox>
  );
}
