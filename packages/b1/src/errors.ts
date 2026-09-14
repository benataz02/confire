/** A Service Layer failure with B1's own error code kept intact, so the cloud can map
 *  status/code to an ORPCError instead of regexing a message string. */
export class B1Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string | number | null,
    message: string,
  ) {
    super(message);
    this.name = "B1Error";
  }

  /** B1 answers `{ error: { code, message: { value } } }` (v2) or `{ error: { code, message } }`. */
  static parse(status: number, payload: unknown): B1Error {
    const err = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const msg = err?.message;
    const text =
      typeof msg === "string" ? msg
      : typeof (msg as { value?: unknown })?.value === "string" ? String((msg as { value: string }).value)
      : typeof payload === "string" ? payload
      // An unreadable payload is a status, not a sentence — a JSON blob in a MessageStrip is
      // exactly the noise this message must not carry.
      : "";
    const code = typeof err?.code === "string" || typeof err?.code === "number" ? err.code : null;
    // The message is B1's own sentence and nothing else: it is what the UI puts in a MessageStrip,
    // and status/code already live as fields for logs and toOrpcError. Prefixing them here would
    // duplicate them into every end-user string.
    return new B1Error(status, code, text.trim() || `SAP returned ${status} with no message.`);
  }
}
