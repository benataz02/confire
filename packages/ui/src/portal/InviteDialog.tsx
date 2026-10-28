import { useState, type ReactNode } from "react";
import { Bar, Button, Dialog, Input, Label, MessageStrip, Option, Select } from "@ui5/webcomponents-react";
import type { PortalRole } from "@confire/db";
import { useUiI18n } from "../i18n.ts";
import { ROLE_HELP_KEY, ROLE_TEXT_KEY, ROLES } from "./CompanyPeople.tsx";

// Invite someone into a customer company (spec §5.1). Shared: an internal admin invites from the BP
// Object Page, a company owner from the portal's company page (D24). Accepting always registers the
// address's domain to the company (onboarding.accept). Mount it only while open, so every opening starts empty.

// UX only — the server validates the address (z.email) and every rule about it.
const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

export type InviteValues = { email: string; role: PortalRole };

export function InviteDialog(p: {
  headerText: string;
  /** who this invites into what */
  intro?: ReactNode;
  /** omitted: the role is not the sender's to choose (a new client's first user is its owner), so
   *  there is no Role select and `role` comes back as owner */
  defaultRole?: PortalRole;
  busy: boolean;
  error?: string | null;
  onSubmit: (v: InviteValues) => void;
  onClose: () => void;
}) {
  const i18n = useUiI18n();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<PortalRole>(p.defaultRole ?? "owner");
  const ok = looksLikeEmail(email) && !p.busy;
  const submit = () => ok && p.onSubmit({ email: email.trim(), role });

  return (
    <Dialog open headerText={p.headerText} onClose={p.onClose} style={{ width: "min(32rem, 92vw)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" disabled={!ok} onClick={submit}>{p.busy ? i18n.getText("UI_SENDING") : i18n.getText("UI_SEND_INVITATION")}</Button>
            <Button onClick={p.onClose}>{i18n.getText("UI_CANCEL")}</Button>
          </>
        } />
      }>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "0.5rem 0" }}>
        {p.error ? <MessageStrip design="Negative" hideCloseButton>{p.error}</MessageStrip> : null}
        {p.intro}
        <Label for="invite-email" required showColon>{i18n.getText("UI_EMAIL")}</Label>
        <Input id="invite-email" type="Email" value={email} style={{ width: "100%" }}
          onInput={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        {p.defaultRole ? (
          <>
            <Label for="invite-role" showColon>{i18n.getText("UI_ROLE")}</Label>
            <Select id="invite-role" value={role} style={{ width: "100%" }}
              onChange={(e) => setRole(e.detail.selectedOption.value as PortalRole)}>
              {ROLES.map((r) => <Option key={r} value={r} additionalText={i18n.getText(ROLE_HELP_KEY[r])}>{i18n.getText(ROLE_TEXT_KEY[r])}</Option>)}
            </Select>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
