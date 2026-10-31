import { Hono } from "hono";
import * as Sentry from "@sentry/bun";
import { z } from "zod";
import { DemoRequestMail, type DemoRequest } from "./mail/demo-mail.tsx";
import { sendMail, type Mail, type SendResult } from "./mail/mailer.ts";
import { readCapped } from "./files.ts";

// The marketing site's demo form (spec 2026-10-30 §9): a plain form POST from confire.ai, which
// Caddy sends to the portal process — external traffic, the portal's event loop. Unlike every other
// mail, this one is awaited: it is the request's only record, so a failed send is an error page the
// visitor sees (with the public contact address), never a request that silently vanished.
// ponytail: no table; a demo_request table when requests need a status or a CRM.

const Lang = z.enum(["en", "es", "eu"]).catch("en");
const oneLine = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\r\n]+$/);
const Fields = z.object({
  name: oneLine(200),
  // Trimmed first, then checked: `z.email()` alone would refuse " ana@firma.es ".
  email: z.string().trim().pipe(z.email().max(254)),
  company: oneLine(200),
  setup: z.string().trim().max(100).default(""),
  message: z.string().trim().max(5000).default(""),
});

const HOUR = 60 * 60_000;
/** The form's maxlengths, percent-encoded at worst, fit well inside: a public route never buffers more. */
const MAX_BODY = 64 * 1024;

/** The campaign: the Referer is the page's own URL, utm_* included (same-origin under
 *  strict-origin-when-cross-origin). */
function utmOf(referer: string | undefined): Record<string, string> {
  try {
    return Object.fromEntries([...new URL(referer ?? "").searchParams].filter(([k]) => k.startsWith("utm_")));
  } catch {
    return {};
  }
}

export function demoRoutes({ send = sendMail, perHour = 5 }: { send?: (mail: Mail) => Promise<SendResult>; perHour?: number } = {}): Hono {
  // assistant/usage.ts' fixed window, per IP and per process — enough for one form.
  const windows = new Map<string, { start: number; n: number }>();
  const limited = (ip: string) => {
    const now = Date.now();
    if (windows.size > 10_000) for (const [k, w] of windows) if (now - w.start >= HOUR) windows.delete(k);
    const w = windows.get(ip);
    if (!w || now - w.start >= HOUR) { windows.set(ip, { start: now, n: 1 }); return false; }
    return ++w.n > perHour;
  };

  return new Hono().post("/api/demo-request", async (c) => {
    const raw = await readCapped(c.req.raw, MAX_BODY);
    const body = Object.fromEntries(new URLSearchParams(raw?.toString("utf8") ?? ""));
    const lang = Lang.parse(body.lang);
    const prefix = lang === "en" ? "" : `/${lang}`;
    const thanks = () => c.redirect(`${prefix}/thanks/`, 303);
    const failed = () => c.redirect(`${prefix}/demo-error/`, 303);

    // A bot filled the field people never see: thank it, send nothing.
    if (body.website) return thanks();
    if (!raw) return failed();
    // Caddy is the only way in and sets X-Forwarded-For itself, so its first value is the client.
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (limited(ip)) return failed();
    const parsed = Fields.safeParse(body);
    if (!parsed.success) return failed();

    const fields: DemoRequest = { ...parsed.data, lang };
    const inbox = process.env.DEMO_INBOX || "";
    const result = inbox
      ? await send({
          to: inbox,
          replyTo: fields.email,
          fromName: "Confire",
          subject: `Demo request: ${fields.company} (${fields.name})`,
          body: DemoRequestMail({ ...fields, utm: utmOf(c.req.header("referer")) }),
        })
      : { error: "DEMO_INBOX is not set" };
    if (!result.error) return thanks();

    // The whole request goes to the log, which is its only copy now; Sentry gets the reason only
    // (instrument.ts sends no personal data).
    console.error("[demo-request] not delivered", JSON.stringify(fields), result.error);
    Sentry.captureMessage(`Demo request not delivered: ${result.error}`);
    return failed();
  });
}
