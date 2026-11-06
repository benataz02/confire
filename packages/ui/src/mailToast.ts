// A sales document's create toast, with what "Notify the client" did (document-mail spec §5.3): the
// server reads the recipients during the post, so the toast says whom it goes to — or why it does not
// — before anything is printed. The send itself runs after the response; a failure there is the
// poster's bell.

/** The create procedures' `mail`: null when the switch was off (or not drawn). */
export type MailAnswer = { to: string[] } | { skipped: "NO_EMAIL" | "NOT_CONNECTED" | "FAILED" } | null | undefined;

const SKIPPED = { NO_EMAIL: "UI_MAIL_NO_EMAIL", NOT_CONNECTED: "UI_MAIL_NOT_CONNECTED", FAILED: "UI_MAIL_FAILED" } as const;

/** `created`, then what the mail did: "Order 260004 created · Sending it to ap@kunde.example". */
export function withMail(created: string, mail: MailAnswer, getText: (key: string, ...args: string[]) => string): string {
  if (!mail) return created;
  const said = "to" in mail ? getText("UI_MAIL_SENDING", mail.to.join(", ")) : getText(SKIPPED[mail.skipped]);
  return `${created} · ${said}`;
}
