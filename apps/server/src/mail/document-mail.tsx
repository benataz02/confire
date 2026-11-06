import { Body, Head, Html, Preview, render, Text } from "react-email";
import { Action, CONFIRE, Fine, H1, Layout, P, type MailLang } from "./layout.tsx";
import type { Mail } from "./mailer.ts";

// Document mail (document-mail spec §5.9): the letter a sales document goes out with, from the
// tenant's own Microsoft 365 mailbox — so a reply reaches the supplier, and it reads like a business
// letter rather than a notification: no Confire frame, no button, the PDF attached. Rendered to HTML
// and sent through Graph (document-mail.ts), never through sendMails, which stays Resend's.
// Below it, the staff notice when one did not go out (Confire's own mail, from notify@).

type Doc = { singular: string; our: string };

/** Each document's name, and "our <document>" for the letter's one sentence. Spanish as the portal's
 *  ("oferta", usted). */
const DOC: Record<MailLang, Record<string, Doc>> = {
  en: {
    Quotations: { singular: "Quotation", our: "our quotation" },
    Orders: { singular: "Order", our: "our order" },
    DeliveryNotes: { singular: "Delivery note", our: "our delivery note" },
    Invoices: { singular: "Invoice", our: "our invoice" },
  },
  es: {
    Quotations: { singular: "Oferta", our: "nuestra oferta" },
    Orders: { singular: "Pedido", our: "nuestro pedido" },
    DeliveryNotes: { singular: "Albarán", our: "nuestro albarán" },
    Invoices: { singular: "Factura", our: "nuestra factura" },
  },
};

const LETTER: Record<MailLang, { hello: string; attached: (our: string, num: string) => string; reply: string; regards: string }> = {
  en: {
    hello: "Hello,", attached: (our, num) => `Please find attached ${our} ${num}.`,
    reply: "If you have any questions, simply reply to this email.", regards: "Kind regards,",
  },
  es: {
    hello: "Estimado cliente:", attached: (our, num) => `Le adjuntamos ${our} ${num}.`,
    reply: "Si tiene cualquier pregunta, responda a este correo.", regards: "Atentamente,",
  },
};

export type DocumentLetterProps = { brandName: string; entity: string; docNum: string; lang: MailLang };

const docOf = (lang: MailLang, entity: string): Doc => DOC[lang][entity] ?? { singular: entity, our: entity };

/** `Invoice 240991` / `Factura 240991`: the attachment's name and the subject's end. */
export const letterTitle = (p: DocumentLetterProps) => `${docOf(p.lang, p.entity).singular} ${p.docNum}`;
/** `<Brand> — Invoice 240991` / `<Brand> — Factura 240991`. */
export const letterSubject = (p: DocumentLetterProps) => `${p.brandName} — ${letterTitle(p)}`;

const text = { color: "#1d2433", fontSize: 15, lineHeight: "24px", margin: "0 0 12px" } as const;

export function DocumentLetter(p: DocumentLetterProps) {
  const w = LETTER[p.lang];
  const line = w.attached(docOf(p.lang, p.entity).our, p.docNum);
  return (
    <Html lang={p.lang}>
      <Head />
      <Body style={{ backgroundColor: "#ffffff", fontFamily: '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', margin: 0, padding: 16 }}>
        <Preview>{line}</Preview>
        <Text style={text}>{w.hello}</Text>
        <Text style={text}>{line}</Text>
        <Text style={text}>{w.reply}</Text>
        <Text style={{ ...text, margin: 0 }}>{w.regards}</Text>
        <Text style={{ ...text, margin: 0 }}>{p.brandName}</Text>
      </Body>
    </Html>
  );
}

export const letterHtml = (p: DocumentLetterProps) => render(<DocumentLetter {...p} />);

export type MailFailedProps = { docName: string; docNum: string; cardCode: string; error: string; url: string };

const failedSubject = (p: MailFailedProps) => `${p.docName} ${p.docNum} was not emailed`;

export function MailFailedMail(p: MailFailedProps) {
  return (
    <Layout brand={CONFIRE} preview={failedSubject(p)}>
      <H1>{failedSubject(p)}</H1>
      <P>Confire could not email {p.docName.toLowerCase()} {p.docNum} ({p.cardCode}) to the customer: {p.error}</P>
      <P>The document is posted in SAP. Send it to the customer by hand, from SAP or your mail program.</P>
      <Action brand={CONFIRE} href={p.url}>Open the document</Action>
      <Fine>Or open this link: {p.url}</Fine>
    </Layout>
  );
}

/** Staff mail is English (CLAUDE.md, Mail), so the document's English name. */
export const englishDocName = (entity: string) => docOf("en", entity).singular;

export const mailFailedMail = (p: MailFailedProps & { to: string }): Mail => ({
  to: p.to, subject: failedSubject(p), fromName: CONFIRE.name,
  body: <MailFailedMail {...p} />,
});
