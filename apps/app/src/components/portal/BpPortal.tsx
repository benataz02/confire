import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BusyIndicator, Button, FlexBox, Input, Label, MessageStrip, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow,
  TableRowAction, Text,
} from "@ui5/webcomponents-react";
import { useLanguage } from "@confire/ui/i18n.ts";
import { useI18n } from "../../i18n.ts";
import { orpc } from "../../orpc.ts";
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
  const i18n = useI18n();
  const [open, setOpen] = useState(false);
  const company = useQuery(companyQuery(cardCode));
  const refresh = useRefresh(cardCode);
  const invite = useMutation(orpc.portalInvitations.inviteExisting.mutationOptions({
    onSuccess: (_r, v) => {
      refresh();
      setOpen(false);
      toast(i18n.getText("ADMIN_INVITE_SENT", v.email));
    },
  }));
  // The first person in becomes its owner by default (spec §5.1): someone has to invite the rest.
  const first = !company.data?.members.length;
  return (
    <>
      <Button icon="paper-plane" disabled={company.isPending} onClick={() => { invite.reset(); setOpen(true); }}>
        {i18n.getText("ADMIN_INVITE_PORTAL")}
      </Button>
      {open ? (
        <InviteDialog
          headerText={i18n.getText("ADMIN_INVITE_PORTAL")}
          intro={<Text>{first
            ? i18n.getText("ADMIN_INVITE_FIRST", cardName)
            : i18n.getText("ADMIN_INVITE_JOIN", cardName)}</Text>}
          defaultRole={first ? "owner" : "buyer"}
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
  const i18n = useI18n();
  // No BP yet, so no SAP language: the mail (and later the lead) takes the sender's.
  const { language } = useLanguage();
  const qc = useQueryClient();
  const invite = useMutation(orpc.portalInvitations.inviteNew.mutationOptions({
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: orpc.portalInvitations.rows.key() });
      onClose();
      toast(i18n.getText("ADMIN_INVITE_SENT", v.email));
    },
  }));
  return (
    <InviteDialog
      headerText={i18n.getText("ADMIN_INVITE_NEW_CLIENT")}
      intro={<Text>{i18n.getText("ADMIN_INVITE_NEW_INTRO")}</Text>}
      busy={invite.isPending}
      error={invite.error?.message}
      onSubmit={({ email }) => invite.mutate({ email, language })}
      onClose={onClose} />
  );
}

const rowKeyOf = (row: unknown) => (row as { rowKey: string }).rowKey;

export function BpPortalSection({ cardCode, cardName }: { cardCode: string; cardName: string }) {
  const i18n = useI18n();
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
  const busy = [setRole, removeMember, cancel, addDomain, removeDomain].some((m) => m.isPending);
  const error = q.error ?? failed;

  if (q.isPending) return <BusyIndicator active delay={0} />;
  const d = q.data;
  return (
    <FlexBox direction="Column" style={{ gap: "1rem", width: "100%" }}>
      {error ? <MessageStrip design="Negative" hideCloseButton>{error.message}</MessageStrip> : null}
      {!d?.company ? (
        <MessageStrip design="Information" hideCloseButton>
          {i18n.getText("ADMIN_PORTAL_EMPTY", cardName, i18n.getText("ADMIN_INVITE_PORTAL"))}
        </MessageStrip>
      ) : (
        <>
          {/* Remounted on every refetch: a refused role change leaves UI5's Select showing the
              value that was picked, and identical data would not re-render it. */}
          <CompanyPeople key={q.dataUpdatedAt} members={d.members} invitations={d.invitations} busy={busy}
            onSetRole={(m, role) => setRole.mutate({ cardCode, userId: m.userId, role })}
            onRemove={async (m) => {
              if (await confirm({ title: i18n.getText("ADMIN_REMOVE_PORTAL_TITLE"), message: i18n.getText("ADMIN_REMOVE_PORTAL_MSG", m.name, m.email, cardName), actionText: i18n.getText("ADMIN_REMOVE"), destructive: true }))
                removeMember.mutate({ cardCode, userId: m.userId });
            }}
            onCancelInvite={async (i) => {
              if (await confirm({ title: i18n.getText("ADMIN_CANCEL_INVITE_TITLE"), message: i18n.getText("ADMIN_CANCEL_INVITE_MSG", i.email), actionText: i18n.getText("ADMIN_CANCEL_INVITE"), destructive: true }))
                cancel.mutate({ ids: [i.id] });
            }} />
          <FlexBox direction="Column" style={{ gap: "0.5rem" }}>
            <Label showColon>{i18n.getText("ADMIN_DOMAINS")}</Label>
            <Text>{i18n.getText("ADMIN_DOMAINS_HELP", cardName)}</Text>
            <Table accessibleName={i18n.getText("ADMIN_DOMAINS")} overflowMode="Popin" noDataText={i18n.getText("ADMIN_NO_DOMAIN")}
              rowActionCount={1}
              onRowActionClick={(e) => {
                const name = rowKeyOf(e.detail.row);
                if (!busy) removeDomain.mutate({ cardCode, domain: name });
              }}
              headerRow={
                <TableHeaderRow>
                  <TableHeaderCell minWidth="12rem">{i18n.getText("ADMIN_DOMAIN")}</TableHeaderCell>
                  <TableHeaderCell width="8rem">{i18n.getText("ADMIN_ADDED")}</TableHeaderCell>
                </TableHeaderRow>
              }>
              {d.domains.map((x) => (
                <TableRow key={x.domain} rowKey={x.domain} actions={<TableRowAction icon="delete" text={i18n.getText("ADMIN_REMOVE_DOMAIN")} />}>
                  <TableCell><Text>{x.domain}</Text></TableCell>
                  <TableCell><Text>{formatValue(x.addedAt, "date")}</Text></TableCell>
                </TableRow>
              ))}
            </Table>
            <FlexBox style={{ gap: "0.5rem" }}>
              <Input value={domain} placeholder="kunde.de" accessibleName={i18n.getText("ADMIN_DOMAIN_INPUT")} style={{ width: "16rem" }}
                onInput={(e) => setDomain(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && domain.trim() && addDomain.mutate({ cardCode, domain })} />
              <Button icon="add" disabled={!domain.trim() || busy} onClick={() => addDomain.mutate({ cardCode, domain })}>
                {i18n.getText("ADMIN_REGISTER_DOMAIN")}
              </Button>
            </FlexBox>
          </FlexBox>
        </>
      )}
    </FlexBox>
  );
}
