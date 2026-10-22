import { Action, Fine, H1, Layout, P, type Brand } from "./layout.tsx";
import type { Mail } from "./mailer.ts";

// Customer portal mail (spec §12). One typed props object per template (spec §17).

export type InvitationProps = {
  /** the supplier: its name and logo, the portal's own branding (D20) */
  brand: Brand;
  inviterName: string;
  /** the customer company the invitee joins (the B1 business partner's name); null for a new
   *  client, who tells the supplier about their company first (spec §5.3) */
  companyName: string | null;
  url: string;
  expiresAt: Date;
};

export function PortalInvitation({ brand, inviterName, companyName, url, expiresAt }: InvitationProps) {
  const until = expiresAt.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  return (
    <Layout brand={brand} preview={`${inviterName} invited you to ${brand.name}'s customer portal`}>
      {companyName ? (
        <>
          <H1>Join {companyName} on {brand.name}'s portal</H1>
          <P>{inviterName} invited you to {brand.name}'s customer portal, as part of {companyName}.</P>
        </>
      ) : (
        <>
          <H1>Set up your company on {brand.name}'s portal</H1>
          <P>{inviterName} invited you to {brand.name}'s customer portal. Tell them about your company — name, address and contact — and your account is ready.</P>
        </>
      )}
      <P>There you can request quotes and follow your orders, deliveries and invoices with {brand.name}.</P>
      <Action brand={brand} href={url}>{companyName ? "Accept the invitation" : "Set up your company"}</Action>
      <Fine>Or open this link: {url}</Fine>
      <Fine>The invitation is valid until {until}. Sign in or create an account with this email address to accept it. If you weren't expecting it, you can ignore this email.</Fine>
    </Layout>
  );
}

/** The invitation as a Mail, from the supplier's name. The key makes a retried send the original send. */
export const invitationMail = (p: InvitationProps & { id: string; to: string }): Mail => ({
  to: p.to,
  subject: `${p.inviterName} invited you to ${p.brand.name}'s customer portal`,
  fromName: p.brand.name,
  sender: p.brand.sender,
  idempotencyKey: `invite/${p.id}`,
  body: <PortalInvitation brand={p.brand} inviterName={p.inviterName} companyName={p.companyName} url={p.url} expiresAt={p.expiresAt} />,
});

/** What staff changed in a round (§7.4), as lines; written with returned, declined or quoted, and
 *  listed in that mail — `revised` sends none of its own. */
const Revision = ({ lines }: { lines: string[] }) => lines.length ? (
  <>
    <P>What changed in your configuration:</P>
    <ul style={{ color: "#41495c", fontSize: 15, lineHeight: "24px", margin: "0 0 8px", paddingLeft: 20 }}>
      {lines.map((l) => <li key={l}>{l}</li>)}
    </ul>
  </>
) : null;

const Note = ({ who, note }: { who: string; note: string | null }) => note
  ? <P><strong>{who}:</strong> “{note}”</P>
  : null;

export type ClientEventKind = "accepted" | "returned" | "declined" | "quoted" | "comment" | "file";

/** A project event a client hears about (D27): the supplier acted on their request. */
export type ClientProjectProps = {
  brand: Brand;
  kind: ClientEventKind;
  projectName: string;
  /** the staff member who acted */
  actorName: string;
  note: string | null;
  revision: string[];
  /** `quoted`: the quotation's number and its value, formatted */
  quote: { docNum: number | null; value: string } | null;
  fileName: string | null;
  url: string;
};

const CLIENT_COPY: Record<ClientEventKind, (p: ClientProjectProps) => { subject: string; title: string; lead: string }> = {
  accepted: (p) => ({
    subject: `${p.brand.name} is reviewing ${p.projectName}`, title: "Your request is in review",
    lead: `${p.actorName} at ${p.brand.name} is now working on ${p.projectName}.`,
  }),
  returned: (p) => ({
    subject: `Changes requested on ${p.projectName}`, title: "Changes requested",
    lead: `${p.actorName} at ${p.brand.name} sent ${p.projectName} back to you. Change what they ask for, then resubmit it.`,
  }),
  declined: (p) => ({
    subject: `${p.projectName} was declined`, title: "Request declined",
    lead: `${p.actorName} at ${p.brand.name} declined ${p.projectName}.`,
  }),
  quoted: (p) => ({
    subject: `Quotation${p.quote?.docNum ? ` ${p.quote.docNum}` : ""} for ${p.projectName}`, title: "Your quotation is ready",
    lead: `${p.brand.name} quoted ${p.projectName}${p.quote ? `: ${p.quote.value}` : ""}. Accept or decline it on the portal.`,
  }),
  comment: (p) => ({
    subject: `${p.actorName} commented on ${p.projectName}`, title: "New comment",
    lead: `${p.actorName} at ${p.brand.name} commented on ${p.projectName}.`,
  }),
  file: (p) => ({
    subject: `${p.actorName} added a file to ${p.projectName}`, title: "New file",
    lead: `${p.actorName} at ${p.brand.name} added ${p.fileName ?? "a file"} to ${p.projectName}.`,
  }),
};

export function ClientProjectMail(p: ClientProjectProps) {
  const c = CLIENT_COPY[p.kind](p);
  return (
    <Layout brand={p.brand} preview={c.lead}>
      <H1>{c.title}</H1>
      <P>{c.lead}</P>
      <Note who={p.actorName} note={p.note} />
      <Revision lines={p.revision} />
      <Action brand={p.brand} href={p.url}>Open the project</Action>
      <Fine>Or open this link: {p.url}</Fine>
    </Layout>
  );
}

export const clientProjectMail = (p: ClientProjectProps & { to: string }): Mail => ({
  to: p.to, subject: CLIENT_COPY[p.kind](p).subject, fromName: p.brand.name, sender: p.brand.sender,
  body: <ClientProjectMail {...p} />,
});

export type StaffEventKind = "submitted" | "resubmitted" | "comment" | "file" | "quote_accepted" | "quote_declined";

/** A request event staff hear about (§12, fixed): a client acted on the portal. */
export type StaffRequestProps = {
  brand: Brand;
  kind: StaffEventKind;
  companyName: string;
  projectName: string;
  /** the client who acted */
  actorName: string;
  note: string | null;
  fileName: string | null;
  url: string;
};

const STAFF_COPY: Record<StaffEventKind, (p: StaffRequestProps) => { subject: string; title: string; lead: string }> = {
  submitted: (p) => ({
    subject: `New request from ${p.companyName}: ${p.projectName}`, title: "New portal request",
    lead: `${p.actorName} (${p.companyName}) submitted ${p.projectName}. Accept it to start the review.`,
  }),
  resubmitted: (p) => ({
    subject: `${p.companyName} resubmitted ${p.projectName}`, title: "Request resubmitted",
    lead: `${p.actorName} (${p.companyName}) made the changes and resubmitted ${p.projectName}.`,
  }),
  comment: (p) => ({
    subject: `${p.actorName} (${p.companyName}) commented on ${p.projectName}`, title: "New comment",
    lead: `${p.actorName} (${p.companyName}) commented on ${p.projectName}.`,
  }),
  file: (p) => ({
    subject: `${p.actorName} (${p.companyName}) added a file to ${p.projectName}`, title: "New file",
    lead: `${p.actorName} (${p.companyName}) added ${p.fileName ?? "a file"} to ${p.projectName}.`,
  }),
  quote_accepted: (p) => ({
    subject: `${p.companyName} accepted the quotation for ${p.projectName}`, title: "Quotation accepted",
    lead: `${p.actorName} (${p.companyName}) accepted the quotation for ${p.projectName}. Create the sales order in SAP.`,
  }),
  quote_declined: (p) => ({
    subject: `${p.companyName} declined the quotation for ${p.projectName}`, title: "Quotation declined",
    lead: `${p.actorName} (${p.companyName}) declined the quotation for ${p.projectName}. The request is back in review.`,
  }),
};

export function StaffRequestMail(p: StaffRequestProps) {
  const c = STAFF_COPY[p.kind](p);
  return (
    <Layout brand={p.brand} preview={c.lead}>
      <H1>{c.title}</H1>
      <P>{c.lead}</P>
      <Note who={p.actorName} note={p.note} />
      <Action brand={p.brand} href={p.url}>Open the request</Action>
      <Fine>Or open this link: {p.url}</Fine>
    </Layout>
  );
}

export const staffRequestMail = (p: StaffRequestProps & { to: string }): Mail => ({
  to: p.to, subject: STAFF_COPY[p.kind](p).subject, fromName: p.brand.name,
  body: <StaffRequestMail {...p} />,
});

/** The inviter's "new client onboarded" (§5.4 step 6): a lead now exists in B1. */
export type ClientOnboardedProps = {
  brand: Brand; clientName: string; clientEmail: string; cardCode: string; cardName: string; url: string;
};

export function ClientOnboardedMail(p: ClientOnboardedProps) {
  return (
    <Layout brand={p.brand} preview={`${p.cardName} is on your customer portal`}>
      <H1>{p.cardName} is on your customer portal</H1>
      <P>{p.clientName} ({p.clientEmail}) accepted your invitation and filled in their company's details. SAP now has the lead {p.cardCode}, and they are its owner on the portal.</P>
      <Action brand={p.brand} href={p.url}>Open the business partner</Action>
      <Fine>Or open this link: {p.url}</Fine>
    </Layout>
  );
}

export const clientOnboardedMail = (p: ClientOnboardedProps & { to: string; invitationId: string }): Mail => ({
  to: p.to, subject: `${p.cardName} joined your customer portal (${p.cardCode})`, fromName: p.brand.name,
  idempotencyKey: `onboarded/${p.invitationId}`,
  body: <ClientOnboardedMail {...p} />,
});
