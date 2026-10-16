import type { ReactNode } from "react";
import {
  Label, ObjectStatus, Option, Select, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text,
} from "@ui5/webcomponents-react";
import type { PortalRole } from "@confire/db";
import { formatValue } from "../format.ts";

// Who is in a customer company and who is invited (spec §9, §10). Presentational: the internal BP
// Object Page and the portal's company page pass their own data and callbacks, so the two show the
// same lists the same way. No callback = read-only.

export const ROLE_LABEL: Record<PortalRole, string> = { owner: "Owner", buyer: "Buyer", viewer: "Viewer" };
export const ROLE_HELP: Record<PortalRole, string> = {
  owner: "Everything a buyer can, plus invite colleagues and manage roles",
  buyer: "Create and submit requests, accept quotes",
  viewer: "Read requests, quotes and documents",
};
export const ROLES = Object.keys(ROLE_LABEL) as PortalRole[];

export type PortalMemberRow = { userId: string; name: string; email: string; role: PortalRole; createdAt: Date | string };
export type PendingInviteRow = { id: string; email: string; role: PortalRole; expiresAt: Date | string; expired: boolean };

const rowKeyOf = (row: unknown) => (row as { rowKey: string }).rowKey;

export function CompanyPeople(p: {
  members: PortalMemberRow[];
  invitations: PendingInviteRow[];
  onSetRole?: (m: PortalMemberRow, role: PortalRole) => void;
  onRemove?: (m: PortalMemberRow) => void;
  onCancelInvite?: (i: PendingInviteRow) => void;
  /** the signed-in user's row reads "(you)" */
  selfId?: string;
  busy?: boolean;
  /** above the members table: an Invite button, say */
  toolbar?: ReactNode;
}) {
  const byId = new Map(p.members.map((m) => [m.userId, m]));
  const inviteById = new Map(p.invitations.map((i) => [i.id, i]));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", width: "100%" }}>
      {p.toolbar}
      <Table
        accessibleName="Members"
        overflowMode="Popin"
        noDataText="Nobody yet."
        rowActionCount={p.onRemove ? 1 : 0}
        onRowActionClick={(e) => {
          const m = byId.get(rowKeyOf(e.detail.row));
          if (m && !p.busy) p.onRemove?.(m); // a row action has no disabled state
        }}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell minWidth="10rem">Name</TableHeaderCell>
            <TableHeaderCell minWidth="12rem">Email</TableHeaderCell>
            <TableHeaderCell width="10rem">Role</TableHeaderCell>
            <TableHeaderCell width="8rem">Joined</TableHeaderCell>
          </TableHeaderRow>
        }
      >
        {p.members.map((m) => (
          <TableRow key={m.userId} rowKey={m.userId}
            actions={p.onRemove ? <TableRowAction icon="delete" text="Remove" /> : undefined}>
            <TableCell><Text>{m.name}{m.userId === p.selfId ? " (you)" : ""}</Text></TableCell>
            <TableCell><Text>{m.email}</Text></TableCell>
            <TableCell>
              {p.onSetRole ? (
                <Select value={m.role} disabled={p.busy} accessibleName={`Role of ${m.name}`} style={{ width: "100%" }}
                  onChange={(e) => p.onSetRole!(m, e.detail.selectedOption.value as PortalRole)}>
                  {ROLES.map((r) => <Option key={r} value={r} tooltip={ROLE_HELP[r]}>{ROLE_LABEL[r]}</Option>)}
                </Select>
              ) : <Text>{ROLE_LABEL[m.role]}</Text>}
            </TableCell>
            <TableCell><Text>{formatValue(m.createdAt, "date")}</Text></TableCell>
          </TableRow>
        ))}
      </Table>
      {p.invitations.length ? (
        <>
          <Label showColon>Invited, not yet joined</Label>
          <Table
            accessibleName="Pending invitations"
            overflowMode="Popin"
            rowActionCount={p.onCancelInvite ? 1 : 0}
            onRowActionClick={(e) => {
              const i = inviteById.get(rowKeyOf(e.detail.row));
              if (i && !p.busy) p.onCancelInvite?.(i);
            }}
            headerRow={
              <TableHeaderRow>
                <TableHeaderCell minWidth="12rem">Email</TableHeaderCell>
                <TableHeaderCell width="10rem">Role</TableHeaderCell>
                <TableHeaderCell width="8rem">Expires</TableHeaderCell>
              </TableHeaderRow>
            }
          >
            {p.invitations.map((i) => (
              <TableRow key={i.id} rowKey={i.id}
                actions={p.onCancelInvite ? <TableRowAction icon="decline" text="Cancel invitation" /> : undefined}>
                <TableCell><Text>{i.email}</Text></TableCell>
                <TableCell><Text>{ROLE_LABEL[i.role]}</Text></TableCell>
                <TableCell>
                  {i.expired
                    ? <ObjectStatus state="Critical">Expired</ObjectStatus>
                    : <Text>{formatValue(i.expiresAt, "date")}</Text>}
                </TableCell>
              </TableRow>
            ))}
          </Table>
        </>
      ) : null}
    </div>
  );
}
