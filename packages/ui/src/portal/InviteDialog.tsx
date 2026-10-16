import { useState, type ReactNode } from "react";
import { Bar, Button, CheckBox, Dialog, Input, Label, MessageStrip, Option, Select } from "@ui5/webcomponents-react";
import type { PortalRole } from "@confire/db";
import { ROLE_HELP, ROLE_LABEL, ROLES } from "./CompanyPeople.tsx";

// Invite someone into a customer company (spec §5.1). Shared: an internal admin invites from the BP
// Object Page (and may register the address's domain), a company owner from the portal's company
// page (never registering one, D24). Mount it only while open, so every opening starts empty.

// UX only — the server validates the address (z.email) and every rule about it.
const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

export type InviteValues = { email: string; role: PortalRole; registerDomain: boolean };

export function InviteDialog(p: {
  headerText: string;
  /** who this invites into what */
  intro?: ReactNode;
  defaultRole: PortalRole;
  /** the company name, to offer "let everyone on this domain join" — the internal side only */
  registerDomainFor?: string;
  busy: boolean;
  error?: string | null;
  onSubmit: (v: InviteValues) => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<PortalRole>(p.defaultRole);
  const [registerDomain, setRegisterDomain] = useState(false);
  const domain = email.includes("@") ? email.slice(email.lastIndexOf("@") + 1).trim().toLowerCase() : "";
  const ok = looksLikeEmail(email) && !p.busy;
  const submit = () => ok && p.onSubmit({ email: email.trim(), role, registerDomain: !!p.registerDomainFor && registerDomain });

  return (
    <Dialog open headerText={p.headerText} onClose={p.onClose} style={{ width: "min(32rem, 92vw)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" disabled={!ok} onClick={submit}>{p.busy ? "Sending…" : "Send invitation"}</Button>
            <Button onClick={p.onClose}>Cancel</Button>
          </>
        } />
      }>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "0.5rem 0" }}>
        {p.error ? <MessageStrip design="Negative" hideCloseButton>{p.error}</MessageStrip> : null}
        {p.intro}
        <Label for="invite-email" required showColon>Email</Label>
        <Input id="invite-email" type="Email" value={email} style={{ width: "100%" }}
          onInput={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        <Label for="invite-role" showColon>Role</Label>
        <Select id="invite-role" value={role} style={{ width: "100%" }}
          onChange={(e) => setRole(e.detail.selectedOption.value as PortalRole)}>
          {ROLES.map((r) => <Option key={r} value={r} additionalText={ROLE_HELP[r]}>{ROLE_LABEL[r]}</Option>)}
        </Select>
        {p.registerDomainFor ? (
          <CheckBox checked={registerDomain} wrappingType="Normal" onChange={(e) => setRegisterDomain(e.target.checked)}
            text={domain
              ? `Anyone with a verified @${domain} address may join ${p.registerDomainFor} as viewer (not for free-mail addresses)`
              : `Anyone with a verified address on the same domain may join ${p.registerDomainFor} as viewer`} />
        ) : null}
      </div>
    </Dialog>
  );
}
