import { ORPCError } from "@orpc/server";
import { Resend } from "resend";
import type { PortalSettings, SenderDomain, SenderDomainRecord } from "@confire/db";
import { mailDomain, sendMails, type Mail, type SendResult } from "../mail/mailer.ts";
import { authUrl } from "../tenant.ts";
import { loadPortalSettings, setSenderDomain, updateSenderDomain } from "./settings.ts";

// A tenant's own sending subdomain (spec D29, §12): while Resend calls it `verified`, client-facing
// mail (invitations and the D27 project events) goes out from notify@<it>. Only these handlers hold
// the full_access key (RESEND_ADMIN_KEY): creating and verifying a domain needs one, and the Mailer's
// sending key cannot. No poller: the status moves on Verify, on opening Settings while it is not
// verified, and when a send from it is refused.

const admin = process.env.RESEND_ADMIN_KEY ? new Resend(process.env.RESEND_ADMIN_KEY) : null;

/** Resend's regions. Fixed when the domain is added. */
export const SENDER_REGIONS = ["eu-west-1", "us-east-1", "sa-east-1", "ap-northeast-1"] as const;
export type SenderRegion = (typeof SENDER_REGIONS)[number];

const platformHost = new URL(authUrl).hostname.toLowerCase();

/**
 * Why `name` cannot be a tenant's sender, or null. A subdomain only: records on it cannot collide
 * with the tenant's own Microsoft 365 SPF/MX, and its reputation stays apart from their mailboxes'.
 * Never under Confire's own domain, which is not the tenant's to verify.
 * ponytail: "subdomain" = at least three labels, so a root under a two-part suffix (mueller.co.uk)
 * slips through. Check against the public suffix list if a tenant ever does that.
 */
export function senderNameProblem(name: string): string | null {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) return "Enter a domain name such as mail.mueller-gmbh.de";
  if (name === platformHost || name.endsWith(`.${platformHost}`) || name === mailDomain)
    return `${name} belongs to Confire: use a subdomain of your own domain`;
  if (name.split(".").length < 3)
    return `Use a subdomain such as mail.${name}: records on ${name} itself would collide with your own email's`;
  return null;
}

function requireAdmin(): Resend {
  if (!admin) throw new ORPCError("BAD_REQUEST", { message: "Sender domains are not set up on this server (RESEND_ADMIN_KEY)" });
  return admin;
}

type ResendRecord = { record: string; name: string; type: string; value: string; ttl: string | number; status: string; priority?: number };
const recordsOf = (rs: ResendRecord[] | undefined): SenderDomainRecord[] => (rs ?? []).map((r) => ({
  record: r.record, name: r.name, type: r.type, value: r.value, ttl: String(r.ttl), status: r.status,
  ...(r.priority === undefined ? {} : { priority: r.priority }),
}));

async function current(tenantId: string): Promise<SenderDomain> {
  const d = (await loadPortalSettings(tenantId)).senderDomain;
  if (!d) throw new ORPCError("NOT_FOUND", { message: "No sender domain is set up" });
  return d;
}

export async function addSenderDomain(tenantId: string, name: string, region: SenderRegion): Promise<SenderDomain> {
  const resend = requireAdmin();
  const problem = senderNameProblem(name);
  if (problem) throw new ORPCError("BAD_REQUEST", { message: problem });
  const stored = (await loadPortalSettings(tenantId)).senderDomain;
  if (stored) throw new ORPCError("CONFLICT", { message: `Remove ${stored.name} first: a portal sends from one domain` });
  const { data, error } = await resend.domains.create({ name, region });
  if (error || !data) {
    // Verified 2026-10-18: a name another Resend team holds is `403 validation_error` "The resend.com
    // domain is registered to another team. You can claim it…". Claiming would move it out of the
    // tenant's own Resend account and break their sending, so this refuses and says so.
    throw new ORPCError("BAD_REQUEST", {
      message: error?.statusCode === 403
        ? `${name} is already registered with Resend by another account, so Confire can't send from it. Use a different subdomain.`
        : `Resend refused ${name}: ${error?.message ?? "no answer"}`,
    });
  }
  const d: SenderDomain = {
    name: data.name, resendDomainId: data.id, region: data.region, status: data.status,
    records: recordsOf(data.records as ResendRecord[]), error: null,
  };
  await setSenderDomain(tenantId, d);
  return d;
}

/** Re-read the domain from Resend (status and records), and store it. Without the admin key, or
 *  when Resend cannot be reached, the stored one comes back with the reason in `error`. */
export async function refreshSenderDomain(tenantId: string, d: SenderDomain): Promise<SenderDomain> {
  if (!admin) return d;
  const { data, error } = await admin.domains.get(d.resendDomainId);
  const next: SenderDomain = error || !data
    ? { ...d, error: error?.message ?? "Resend did not answer" }
    : { ...d, status: data.status, records: recordsOf(data.records as ResendRecord[]), error: null };
  await updateSenderDomain(tenantId, d.resendDomainId, next);
  return next;
}

/** *Verify*: ask Resend to check the DNS records now, then read where it stands. Resend's check is
 *  asynchronous, so a domain whose records are right may still say `pending` for a moment. */
export async function verifySenderDomain(tenantId: string): Promise<SenderDomain> {
  const d = await current(tenantId);
  const { error } = await requireAdmin().domains.verify(d.resendDomainId);
  if (error) {
    const next = { ...d, error: error.message };
    await updateSenderDomain(tenantId, d.resendDomainId, next);
    return next;
  }
  return refreshSenderDomain(tenantId, d);
}

export async function removeSenderDomain(tenantId: string): Promise<void> {
  const d = await current(tenantId);
  const { error } = await requireAdmin().domains.remove(d.resendDomainId);
  // Already gone from Resend (removed in its dashboard) is the outcome Remove wanted.
  if (error && error.statusCode !== 404) throw new ORPCError("BAD_GATEWAY", { message: `Resend refused to remove ${d.name}: ${error.message}` });
  await setSenderDomain(tenantId, null);
}

/**
 * Client-facing mail (D29): from the tenant's own domain while it is verified, else from
 * mail.<domain>. The stored status can be stale, so a 403 on a send from the tenant's domain is
 * retried once from ours, and the domain is marked failed with Resend's message so Settings shows
 * why — a bad DNS change costs branding, never a mail. Keyed on the status, not the message:
 * Resend's name for it (`validation_error`) covers much else (verified 2026-10-18).
 * ponytail: unverified (spec §16) — that a sending_access key with no domainId may send from every
 * domain on the account; only a verified tenant domain can show it.
 */
export async function sendClientMail(settings: PortalSettings, tenantId: string, mails: Mail[], key: string): Promise<SendResult> {
  const own = settings.senderDomain?.status === "verified" ? settings.senderDomain : null;
  const first = await sendMails(mails.map((m) => ({ ...m, fromDomain: own?.name })), key);
  if (!own || first.status !== 403) return first;
  await updateSenderDomain(tenantId, own.resendDomainId, { status: "failed", error: first.error });
  // A key of its own: the first one is bound to the refused payload (same key + another payload = 409).
  return sendMails(mails, `${key}/fallback`);
}
