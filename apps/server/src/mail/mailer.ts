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
  /** The From display name — the address is always notify@<MAIL_DOMAIN>. */
  fromName: string;
  replyTo?: string;
  /** `<event>/<id>` (Resend keeps it 24 h): a retried send is the original send, not a second mail. */
  idempotencyKey?: string;
};

export type SentMail = { to: string; subject: string; from: string; html: string; text: string };

// A sending_access key: it can send and nothing else, so a leak cannot touch domains or keys.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const mailDomain = (process.env.MAIL_DOMAIN ?? "mail.lvh.me").toLowerCase();

/** RFC 5322 quoted display name: `"` and `\` escaped, so `Müller & Söhne, GmbH` stays one name and
 *  cannot inject a second address. */
export const formatFrom = (name: string, address: string) => `"${name.replace(/["\\]/g, "\\$&")}" <${address}>`;

/** What the console mailer sent, newest last — dev reads links out of the server log, tests out of
 *  here. ponytail: last 50 only, in memory; it is a dev convenience, not an outbox. */
export const devOutbox: SentMail[] = [];

/** Never throws: `error` is Resend's message (what a caller stores as `mailError`), or a render or
 *  network failure's. */
export async function sendMail(mail: Mail): Promise<{ id: string | null; error: string | null }> {
  try {
    const from = formatFrom(mail.fromName, `notify@${mailDomain}`);
    const [html, text] = await Promise.all([render(mail.body), render(mail.body, { plainText: true })]);
    if (!resend) {
      devOutbox.push({ to: mail.to, subject: mail.subject, from, html, text });
      if (devOutbox.length > 50) devOutbox.shift();
      console.log(`[mail] ${from} -> ${mail.to}: ${mail.subject}\n${text}\n`);
      return { id: null, error: null };
    }
    // The SDK returns { data, error } instead of throwing.
    const { data, error } = await resend.emails.send(
      { from, to: mail.to, subject: mail.subject, html, text, ...(mail.replyTo ? { replyTo: mail.replyTo } : {}) },
      mail.idempotencyKey ? { idempotencyKey: mail.idempotencyKey } : undefined,
    );
    return { id: data?.id ?? null, error: error?.message ?? null };
  } catch (e) {
    return { id: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Fire and forget, logging a failure — for callers with no row to record `mailError` on. */
export function sendMailInBackground(mail: Mail): void {
  void sendMail(mail).then((r) => {
    if (r.error) console.error(`[mail] ${mail.subject} -> ${mail.to} failed: ${r.error}`);
  });
}
