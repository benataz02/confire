import type { ReactElement } from "react";
import { render } from "react-email";
import { Resend } from "resend";

// The Mailer seam (spec D13): Resend when RESEND_API_KEY is set, the console otherwise. That is
// configuration, not a dev/prod branch — the same as an unset GOOGLE_CLIENT_ID leaving its button dead.
// Every caller fires and forgets: a mail is never on a request's critical path (spec §12), so a
// slow Resend costs nothing, and a sign-in's timing never depends on whether a mail went out.

export type Mail = {
  to: string;
  subject: string;
  /** One React Email template with its typed props (spec §17); rendered to HTML and text on send. */
  body: ReactElement;
  /** The From display name — the address is always notify@<domain>. */
  fromName: string;
  /** The From address's domain: a tenant's verified sender (D29). Absent = MAIL_DOMAIN. */
  fromDomain?: string;
  replyTo?: string;
  /** `<event>/<id>` (Resend keeps it 24 h): a retried send is the original send, not a second mail. */
  idempotencyKey?: string;
};

export type SentMail = { to: string; subject: string; from: string; replyTo?: string; html: string; text: string };
/** `status` is Resend's HTTP status on a refusal: a 403 from a tenant's domain is the D29 fallback. */
export type SendResult = { error: string | null; status: number | null };

// A sending_access key: it can send and nothing else, so a leak cannot touch domains or keys.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
/** Confire's own sending domain, `mail.<domain>`: account and internal mail, and every fallback. */
export const mailDomain = (process.env.MAIL_DOMAIN ?? "mail.lvh.me").toLowerCase();

/** RFC 5322 quoted display name: `"` and `\` escaped, so `Müller & Söhne, GmbH` stays one name and
 *  cannot inject a second address. */
export const formatFrom = (name: string, address: string) => `"${name.replace(/["\\]/g, "\\$&")}" <${address}>`;

/** What the console mailer sent, newest last — dev reads links out of the server log, tests out of
 *  here. ponytail: last 50 only, in memory; it is a dev convenience, not an outbox. */
export const devOutbox: SentMail[] = [];

async function rendered(mail: Mail) {
  const from = formatFrom(mail.fromName, `notify@${mail.fromDomain ?? mailDomain}`);
  const [html, text] = await Promise.all([render(mail.body), render(mail.body, { plainText: true })]);
  return { from, to: mail.to, subject: mail.subject, html, text, ...(mail.replyTo ? { replyTo: mail.replyTo } : {}) };
}

/**
 * One mail per recipient, so colleagues never see each other's addresses; two or more go as one
 * atomic `POST /emails/batch` (≤ 100, no attachments — no notification has one) under one key.
 * Never throws: `error` is Resend's message (what a caller stores as `mailError`), or a render or
 * network failure's.
 * ponytail: ≤ 100 recipients (Resend's batch cap; past it the whole batch is refused and the error
 * recorded). Chunk with a key per chunk if a company or a supplier's staff ever gets that big.
 */
export async function sendMails(mails: Mail[], idempotencyKey?: string): Promise<SendResult> {
  if (!mails.length) return { error: null, status: null };
  try {
    const out = await Promise.all(mails.map(rendered));
    if (!resend) {
      for (const m of out) {
        devOutbox.push(m);
        if (devOutbox.length > 50) devOutbox.shift();
        console.log(`[mail] ${m.from} -> ${m.to}: ${m.subject}\n${m.text}\n`);
      }
      return { error: null, status: null };
    }
    const options = idempotencyKey ? { idempotencyKey } : undefined;
    // The SDK returns { data, error } instead of throwing.
    const { error } = out.length === 1 ? await resend.emails.send(out[0]!, options) : await resend.batch.send(out, options);
    return { error: error?.message ?? null, status: error?.statusCode ?? null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), status: null };
  }
}

export const sendMail = (mail: Mail) => sendMails([mail], mail.idempotencyKey);

/** Fire and forget, logging a failure — for callers with no row to record `mailError` on. */
export function sendMailInBackground(mail: Mail): void {
  void sendMail(mail).then((r) => {
    if (r.error) console.error(`[mail] ${mail.subject} -> ${mail.to} failed: ${r.error}`);
  });
}
