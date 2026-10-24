import { Action, Fine, H1, Layout, MAIL_LOCALE, P, type Brand, type MailLang } from "./layout.tsx";
import type { Mail } from "./mailer.ts";

// Customer portal mail: invitations, and the mail side of a project notification (notifications spec
// 2026-10-22; notify.ts decides who gets one). One typed props object per template (spec §17).
// Client mail is in its company's SAP language (`lang`, layout.tsx `mailLang`), worded like the
// portal's own Spanish (usted, "oferta"); staff mail below stays English.

/** What every client mail says around its own copy. */
const CLIENT_UI: Record<MailLang, { orLink: string; openProject: string; changed: string }> = {
  en: { orLink: "Or open this link:", openProject: "Open the project", changed: "What changed in your configuration:" },
  es: { orLink: "O abra este enlace:", openProject: "Abrir el proyecto", changed: "Cambios en su configuración:" },
};

export type InvitationProps = {
  /** the supplier: its name and logo, the portal's own branding (D20) */
  brand: Brand;
  inviterName: string;
  /** the customer company the invitee joins (the B1 business partner's name); null for a new
   *  client, who tells the supplier about their company first (spec §5.3) */
  companyName: string | null;
  url: string;
  expiresAt: Date;
  lang: MailLang;
};

type InvitationCopy = { subject: string; title: string; lead: string; about: string; action: string; valid: string };

const INVITATION_COPY: Record<MailLang, (p: InvitationProps, until: string) => InvitationCopy> = {
  en: ({ brand, inviterName, companyName }, until) => ({
    subject: `${inviterName} invited you to ${brand.name}'s customer portal`,
    ...(companyName ? {
      title: `Join ${companyName} on ${brand.name}'s portal`,
      lead: `${inviterName} invited you to ${brand.name}'s customer portal, as part of ${companyName}.`,
      action: "Accept the invitation",
    } : {
      title: `Set up your company on ${brand.name}'s portal`,
      lead: `${inviterName} invited you to ${brand.name}'s customer portal. Tell them about your company — name, address and contact — and your account is ready.`,
      action: "Set up your company",
    }),
    about: `There you can request quotes and follow your orders, deliveries and invoices with ${brand.name}.`,
    valid: `The invitation is valid until ${until}. Sign in or create an account with this email address to accept it. If you weren't expecting it, you can ignore this email.`,
  }),
  es: ({ brand, inviterName, companyName }, until) => ({
    subject: `${inviterName} le ha invitado al portal de clientes de ${brand.name}`,
    ...(companyName ? {
      title: `Únase a ${companyName} en el portal de ${brand.name}`,
      lead: `${inviterName} le ha invitado al portal de clientes de ${brand.name}, como parte de ${companyName}.`,
      action: "Aceptar la invitación",
    } : {
      title: `Dé de alta su empresa en el portal de ${brand.name}`,
      lead: `${inviterName} le ha invitado al portal de clientes de ${brand.name}. Facilite los datos de su empresa (nombre, dirección y contacto) y su cuenta quedará lista.`,
      action: "Dar de alta su empresa",
    }),
    about: `Allí puede solicitar ofertas y seguir sus pedidos, entregas y facturas con ${brand.name}.`,
    valid: `La invitación es válida hasta el ${until}. Inicie sesión o cree una cuenta con esta dirección de correo para aceptarla. Si no la esperaba, puede ignorar este correo.`,
  }),
};

const invitationCopy = (p: InvitationProps) =>
  INVITATION_COPY[p.lang](p, p.expiresAt.toLocaleDateString(MAIL_LOCALE[p.lang], { day: "numeric", month: "long", year: "numeric" }));

export function PortalInvitation(p: InvitationProps) {
  const c = invitationCopy(p);
  return (
    <Layout brand={p.brand} preview={c.subject} lang={p.lang}>
      <H1>{c.title}</H1>
      <P>{c.lead}</P>
      <P>{c.about}</P>
      <Action brand={p.brand} href={p.url}>{c.action}</Action>
      <Fine>{CLIENT_UI[p.lang].orLink} {p.url}</Fine>
      <Fine>{c.valid}</Fine>
    </Layout>
  );
}

/** The invitation as a Mail, from the supplier's name. The key makes a retried send the original send. */
export const invitationMail = ({ id, to, ...p }: InvitationProps & { id: string; to: string }): Mail => ({
  to,
  subject: invitationCopy(p).subject,
  fromName: p.brand.name,
  sender: p.brand.sender,
  idempotencyKey: `invite/${id}`,
  body: <PortalInvitation {...p} />,
});

/** What staff changed in a round (§7.4), as lines; written with returned, declined or quoted, and
 *  listed in that mail — `revised` sends none of its own. */
const Revision = ({ lines, lang }: { lines: string[]; lang: MailLang }) => lines.length ? (
  <>
    <P>{CLIENT_UI[lang].changed}</P>
    <ul style={{ color: "#41495c", fontSize: 15, lineHeight: "24px", margin: "0 0 8px", paddingLeft: 20 }}>
      {lines.map((l) => <li key={l}>{l}</li>)}
    </ul>
  </>
) : null;

const Note = ({ who, note }: { who: string; note: string | null }) => note
  ? <P><strong>{who}:</strong> “{note}”</P>
  : null;

export type ClientEventKind = "accepted" | "returned" | "declined" | "quoted" | "comment" | "file";

/** A project event a client hears about: the supplier acted on their request. */
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
  lang: MailLang;
};

type ClientCopy = Record<ClientEventKind, (p: ClientProjectProps) => { subject: string; title: string; lead: string }>;

const CLIENT_COPY_ES: ClientCopy = {
  accepted: (p) => ({
    subject: `${p.brand.name} está revisando ${p.projectName}`, title: "Su solicitud está en revisión",
    lead: `${p.actorName}, de ${p.brand.name}, ya está trabajando en ${p.projectName}.`,
  }),
  returned: (p) => ({
    subject: `Cambios solicitados en ${p.projectName}`, title: "Cambios solicitados",
    lead: `${p.actorName}, de ${p.brand.name}, le ha devuelto ${p.projectName}. Haga los cambios que le piden y vuelva a enviarlo.`,
  }),
  declined: (p) => ({
    subject: `Solicitud rechazada: ${p.projectName}`, title: "Solicitud rechazada",
    lead: `${p.actorName}, de ${p.brand.name}, ha rechazado ${p.projectName}.`,
  }),
  quoted: (p) => ({
    subject: `Oferta${p.quote?.docNum ? ` ${p.quote.docNum}` : ""} para ${p.projectName}`, title: "Su oferta está lista",
    lead: `${p.brand.name} ha enviado la oferta de ${p.projectName}${p.quote ? `: ${p.quote.value}` : ""}. Acéptela o recházela en el portal.`,
  }),
  comment: (p) => ({
    subject: `${p.actorName} ha comentado en ${p.projectName}`, title: "Nuevo comentario",
    lead: `${p.actorName}, de ${p.brand.name}, ha comentado en ${p.projectName}.`,
  }),
  file: (p) => ({
    subject: `${p.actorName} ha añadido un archivo a ${p.projectName}`, title: "Nuevo archivo",
    lead: `${p.actorName}, de ${p.brand.name}, ha añadido ${p.fileName ?? "un archivo"} a ${p.projectName}.`,
  }),
};

const CLIENT_COPY_EN: ClientCopy = {
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

const CLIENT_COPY: Record<MailLang, ClientCopy> = { en: CLIENT_COPY_EN, es: CLIENT_COPY_ES };

export function ClientProjectMail(p: ClientProjectProps) {
  const c = CLIENT_COPY[p.lang][p.kind](p);
  const ui = CLIENT_UI[p.lang];
  return (
    <Layout brand={p.brand} preview={c.lead} lang={p.lang}>
      <H1>{c.title}</H1>
      <P>{c.lead}</P>
      <Note who={p.actorName} note={p.note} />
      <Revision lines={p.revision} lang={p.lang} />
      <Action brand={p.brand} href={p.url}>{ui.openProject}</Action>
      <Fine>{ui.orLink} {p.url}</Fine>
    </Layout>
  );
}

export const clientProjectMail = (p: ClientProjectProps & { to: string }): Mail => ({
  to: p.to, subject: CLIENT_COPY[p.lang][p.kind](p).subject, fromName: p.brand.name, sender: p.brand.sender,
  body: <ClientProjectMail {...p} />,
});

export type StaffEventKind = "submitted" | "resubmitted" | "comment" | "file" | "quote_accepted" | "quote_declined" | "assigned";

/** A request event staff hear about: a client acted on the portal, or a colleague handed it over. */
export type StaffRequestProps = {
  brand: Brand;
  kind: StaffEventKind;
  companyName: string;
  projectName: string;
  /** the client who acted, or for `assigned` the colleague */
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
  assigned: (p) => ({
    subject: `${p.actorName} assigned ${p.projectName} (${p.companyName}) to you`, title: "Request assigned to you",
    lead: `${p.actorName} assigned ${p.companyName}'s request ${p.projectName} to you.`,
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
