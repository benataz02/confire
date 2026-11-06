import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import * as Sentry from "@sentry/bun";
import { z } from "zod";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db, configProject, configProjectEvent, DOCUMENT_MAIL_TYPES, documentMail, organization, user, verification,
  type DocumentMailSettings, type DocumentMailType,
} from "@confire/db";
import type { B1Transport } from "@confire/b1";
import { auth } from "./auth.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import { letterHtml, letterSubject, letterTitle } from "./mail/document-mail.tsx";
import { mailLang, type MailLang } from "./mail/layout.tsx";
import { background, notifyMailFailed } from "./notify.ts";
import { membershipOf } from "./orpc/base.ts";
import { tenantBrand } from "./portal/settings.ts";
import { printDocument } from "./print.ts";
import { addDocumentSent } from "./project-lifecycle.ts";
import { appTenantUrl, authUrl, tenantSlug } from "./tenant.ts";
import { t } from "./i18n/index.ts";

// Document mail (spec docs/superpowers/specs/2026-11-06-document-mail-design.md): a sales document
// posted from one of Confire's create pages, sent on to the customer from the supplier's own
// Microsoft 365 mailbox, its PDF attached — and, when it belongs to a project, onto the project's
// timeline. The ONLY writer of `document_mail`. Confire's own mail (Resend, mail/mailer.ts) stays for
// notifications: a tenant's business documents never leave from Confire's sending domain.
//
// The mailbox is connected once per workspace by an admin, through Microsoft's delegated OAuth code
// flow (two plain routes below); the refresh token is stored encrypted and redeemed per send. Nothing
// takes a recipient, subject, body or attachment from a client: recipients come from SAP
// (`recipientsOf`), the attachment from `printDocument`, so the mailbox can never become a mailer.
// A mail is never on a request's critical path and never fails a post; Graph's sendMail has no
// idempotency key, so nothing retries a send on its own.

const LOGIN = "https://login.microsoftonline.com/organizations/oauth2/v2.0";
const GRAPH = "https://graph.microsoft.com/v1.0";
// The sign-in app's registration (auth.ts), with delegated mail permissions added, requested only by
// this flow. Send and nothing else: no Mail.Read. `openid` is for the ID token's `tid` alone.
const SCOPES = "openid offline_access User.Read Mail.Send Mail.Send.Shared";
const REDIRECT = `${authUrl}/api/mail/microsoft/callback`;
const STATE = "mail-oauth:";
const STATE_TTL_MS = 10 * 60_000;
/** Graph's inline attachment limit. ponytail: under 3 MB only; a draft and an upload session (up to
 *  150 MB) when a document's PDF ever needs it. */
const MAX_PDF = 3 * 1024 * 1024;

// Read on use, not at import: tests drop the secret in their preload, and an unset one is dev.
const clientId = () => process.env.MICROSOFT_CLIENT_ID || "";
const clientSecret = () => process.env.MICROSOFT_CLIENT_SECRET || "";
const isAdmin = (role: string) => role === "admin" || role === "owner";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Where the connect flow lands, `?mail=` a code the Settings card turns into words. */
const settingsUrl = (slug: string, code?: string) =>
  `${appTenantUrl(slug, "/settings")}?tab=email${code ? `&mail=${code}` : ""}`;

class TokenError extends Error {
  constructor(readonly code: string, description?: string) {
    super(description ? `${code}: ${description.split(/\r?\n/)[0]}` : code);
  }
}

type TokenAnswer = { access_token: string; refresh_token?: string; expires_in: number; id_token?: string };

async function tokenRequest(params: Record<string, string>): Promise<TokenAnswer> {
  const res = await fetch(`${LOGIN}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), scope: SCOPES, ...params }),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<TokenAnswer> & { error?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new TokenError(json.error ?? `HTTP ${res.status}`, json.error_description);
  return json as TokenAnswer;
}

/** Microsoft's refusal as a code for the card: an admin has to approve the app for the organisation,
 *  the user said no, or anything else. */
function refusal(error: string, description = ""): string {
  if (error === "consent_required" || /AADSTS(65001|90094|90099|900941)\b/.test(description)) return "admin";
  return error === "access_denied" ? "denied" : "failed";
}

// Access tokens live ~1 h; each is kept until 5 minutes before it expires. Per process, never shared.
const tokens = new Map<string, { token: string; until: number }>();
const keep = (tenantId: string, a: TokenAnswer) =>
  tokens.set(tenantId, { token: a.access_token, until: Date.now() + (a.expires_in - 300) * 1000 });

/**
 * A Graph access token for the workspace's mailbox: the cached one, else the refresh token redeemed —
 * each redeem answers a new refresh token, stored in its place (they last ~90 days unused). A refused
 * refresh (`invalid_grant`: revoked, expired, password changed) lands on the row for the card's
 * Reconnect and fails the send.
 * ponytail: two sends at once may both redeem; harmless, Microsoft keeps the older refresh token valid.
 */
export async function graphToken(tenantId: string): Promise<string> {
  const hit = tokens.get(tenantId);
  if (hit && hit.until > Date.now()) return hit.token;
  const [row] = await db.select({ refreshToken: documentMail.refreshToken }).from(documentMail)
    .where(and(eq(documentMail.tenantId, tenantId), isNotNull(documentMail.account))).limit(1);
  if (!row?.refreshToken) throw new Error(t("DOCUMENT_MAIL_NOT_CONNECTED"));
  // A disconnect since the read must not be undone: every write below needs the account still there.
  const connected = and(eq(documentMail.tenantId, tenantId), isNotNull(documentMail.account));
  try {
    const a = await tokenRequest({ grant_type: "refresh_token", refresh_token: decryptSecret(row.refreshToken) });
    if (a.refresh_token) {
      await db.update(documentMail).set({ refreshToken: encryptSecret(a.refresh_token), error: null, updatedAt: new Date() }).where(connected);
    }
    keep(tenantId, a);
    return a.access_token;
  } catch (e) {
    if (e instanceof TokenError && (e.code === "invalid_grant" || e.code === "interaction_required")) {
      await db.update(documentMail).set({ error: e.message, updatedAt: new Date() }).where(connected);
      throw new Error(t("DOCUMENT_MAIL_RECONNECT"));
    }
    throw e;
  }
}

/** Connect, as two plain GETs on the staff process (a full page load each way): Microsoft's sign-in
 *  cannot be an RPC. The state is single-use, bound to (tenant, user) and 10 minutes, in Better Auth's
 *  `verification` table as the pairing code is; PKCE on top. */
export function documentMailRoutes(): Hono {
  const app = new Hono();

  app.get("/api/mail/microsoft/connect", async (c) => {
    const slug = tenantSlug(c.req.query("tenant"));
    if (!slug) return c.redirect(authUrl);
    const session = await auth.api.getSession({ headers: c.req.raw.headers, query: { disableCookieCache: true } });
    // Signed out: the page's own guard sends them to sign-in.
    if (!session) return c.redirect(settingsUrl(slug));
    const m = await membershipOf(slug, session.user.id).catch(() => null);
    if (!m || !isAdmin(m.role)) return c.redirect(settingsUrl(slug, "forbidden"));
    if (!clientId() || !clientSecret()) return c.redirect(settingsUrl(slug, "unavailable"));
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    await db.insert(verification).values({
      id: crypto.randomUUID(), identifier: `${STATE}${state}`,
      value: JSON.stringify({ tenantId: m.tenantId, userId: session.user.id, slug, verifier }),
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });
    const url = new URL(`${LOGIN}/authorize`);
    url.search = new URLSearchParams({
      client_id: clientId(), response_type: "code", redirect_uri: REDIRECT, response_mode: "query", scope: SCOPES,
      state, prompt: "select_account",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    }).toString();
    return c.redirect(url.toString());
  });

  app.get("/api/mail/microsoft/callback", async (c) => {
    const q = c.req.query();
    // Back from the admin-consent link (`state=consent:<slug>`, settings below): nothing to store —
    // an admin of the customer's organisation approved the app, so Connect works now.
    if (q.state?.startsWith("consent:")) {
      const slug = tenantSlug(q.state.slice("consent:".length));
      return c.redirect(slug ? settingsUrl(slug, q.error ? refusal(q.error, q.error_description) : "consented") : authUrl);
    }
    const [claimed] = q.state
      ? await db.delete(verification).where(eq(verification.identifier, `${STATE}${q.state}`)).returning()
      : [];
    if (!claimed) return c.redirect(authUrl);
    const s = JSON.parse(claimed.value) as { tenantId: string; userId: string; slug: string; verifier: string };
    const back = (code?: string) => c.redirect(settingsUrl(s.slug, code));
    if (claimed.expiresAt < new Date()) return back("expired");
    if (q.error || !q.code) return back(refusal(q.error ?? "", q.error_description));
    // The same person, still an admin there: the state alone is not a session.
    const session = await auth.api.getSession({ headers: c.req.raw.headers, query: { disableCookieCache: true } });
    const m = session?.user.id === s.userId ? await membershipOf(s.slug, s.userId).catch(() => null) : null;
    if (!m || m.tenantId !== s.tenantId || !isAdmin(m.role)) return back("forbidden");
    try {
      const a = await tokenRequest({ grant_type: "authorization_code", code: q.code, redirect_uri: REDIRECT, code_verifier: s.verifier });
      if (!a.refresh_token) throw new Error("Microsoft answered no refresh token");
      const meRes = await fetch(`${GRAPH}/me?$select=mail,userPrincipalName`, { headers: { authorization: `Bearer ${a.access_token}` } });
      const me = (await meRes.json()) as { mail?: string | null; userPrincipalName?: string };
      const account = me.mail || me.userPrincipalName;
      if (!meRes.ok || !account) throw new Error(`Graph /me answered ${meRes.status}`);
      // Straight from the token endpoint over TLS, so the ID token's claims need no signature check
      // (OIDC Core §3.1.3.7).
      const tid = a.id_token ? (JSON.parse(Buffer.from(a.id_token.split(".")[1] ?? "", "base64url").toString()) as { tid?: string }).tid : undefined;
      const row = {
        account, msTenantId: tid ?? null, refreshToken: encryptSecret(a.refresh_token),
        connectedBy: s.userId, connectedAt: new Date(), error: null, updatedAt: new Date(),
      };
      await db.insert(documentMail).values({ tenantId: s.tenantId, ...row })
        .onConflictDoUpdate({ target: documentMail.tenantId, set: row });
      keep(s.tenantId, a);
      return back("connected");
    } catch (e) {
      console.error("[document mail] connect", e);
      Sentry.captureException(e);
      return back("failed");
    }
  });

  return app;
}

// --- Settings → Email ------------------------------------------------------------------------------

export const SettingsZ = z.object({
  types: z.partialRecord(z.enum(DOCUMENT_MAIL_TYPES), z.object({
    notify: z.boolean(),
    // Only checked as an address: whether the account may send as it is Microsoft's answer (§5.2).
    from: z.email().max(254).optional(),
  })),
}) satisfies z.ZodType<DocumentMailSettings>;

const loadRow = async (tenantId: string) =>
  (await db.select({
    settings: documentMail.settings, account: documentMail.account, connectedAt: documentMail.connectedAt,
    error: documentMail.error, connectedBy: user.name,
  }).from(documentMail).leftJoin(user, eq(user.id, documentMail.connectedBy))
    .where(eq(documentMail.tenantId, tenantId)).limit(1))[0];

/** The card: the connection (never its token) and the per-type settings. */
export async function mailSettings(tenantId: string) {
  const [row, [org]] = await Promise.all([
    loadRow(tenantId),
    db.select({ slug: organization.slug }).from(organization).where(eq(organization.id, tenantId)).limit(1),
  ]);
  const consent = new URL("https://login.microsoftonline.com/organizations/adminconsent");
  consent.search = new URLSearchParams({ client_id: clientId(), redirect_uri: REDIRECT, state: `consent:${org?.slug ?? ""}` }).toString();
  return {
    /** the server has the Microsoft app's credentials: without them nothing can connect */
    available: !!clientId() && !!clientSecret(),
    account: row?.account ?? null,
    connectedBy: row?.account ? row.connectedBy ?? null : null,
    connectedAt: row?.account ? row.connectedAt ?? null : null,
    error: row?.account ? row.error ?? null : null,
    settings: row?.settings ?? { types: {} },
    /** for the customer's IT, when Microsoft says an admin must approve the app */
    adminConsentUrl: consent.toString(),
  };
}

export async function saveMailSettings(tenantId: string, settings: DocumentMailSettings) {
  await db.insert(documentMail).values({ tenantId, settings, updatedAt: new Date() })
    .onConflictDoUpdate({ target: documentMail.tenantId, set: { settings, updatedAt: new Date() } });
}

/** The account and its token go; the per-type settings stay. Microsoft cannot revoke one refresh
 *  token without signing the account out everywhere, so the card points at My Apps for that. */
export async function disconnectMail(tenantId: string) {
  tokens.delete(tenantId);
  await db.update(documentMail).set({
    account: null, msTenantId: null, refreshToken: null, connectedBy: null, connectedAt: null, error: null, updatedAt: new Date(),
  }).where(eq(documentMail.tenantId, tenantId));
}

/** What the create pages draw: the switch only with a mailbox, starting at each type's default. */
export async function mailStatus(tenantId: string) {
  const row = await loadRow(tenantId);
  return {
    connected: !!row?.account,
    defaults: Object.fromEntries(DOCUMENT_MAIL_TYPES.map((k) => [k, !!row?.settings.types[k]?.notify])) as Record<DocumentMailType, boolean>,
  };
}

// --- recipients (§5.4) -----------------------------------------------------------------------------

const Email = z.email();
/** `E_Mail` and `EmailAddress` are free text: several addresses split on `;` or `,`, junk dropped. */
const addresses = (v: unknown): string[] => typeof v === "string"
  ? [...new Set(v.split(/[;,]/).map((s) => s.trim()).filter((s) => Email.safeParse(s).success))]
  : [];
/** An entity read answers the enum's name, a $crossjoin its value. */
const active = (v: unknown) => v === "tYES" || v === "Y";

/** Whom B1's own Send would pick: the document's contact person if active and with an email, else
 *  the business partner's general address — where B1 would leave it empty. Pure. */
export function recipientsOf(
  doc: { ContactPersonCode?: unknown },
  bp: { EmailAddress?: unknown; LanguageCode?: unknown; ContactEmployees?: unknown },
): { to: string[]; lang: MailLang } {
  const code = Number(doc.ContactPersonCode);
  const contacts = Array.isArray(bp.ContactEmployees) ? (bp.ContactEmployees as Record<string, unknown>[]) : [];
  const contact = code ? contacts.find((c) => Number(c.InternalCode) === code) : undefined;
  const own = contact && active(contact.Active) ? addresses(contact.E_Mail) : [];
  return {
    to: own.length ? own : addresses(bp.EmailAddress),
    lang: mailLang(typeof bp.LanguageCode === "number" ? bp.LanguageCode : null),
  };
}

// --- sending (§5.5) --------------------------------------------------------------------------------

/** What a create procedure answers: whom it is sending to, why not, or null with the switch off. */
export type MailAnswer = { to: string[] } | { skipped: "NO_EMAIL" | "NOT_CONNECTED" | "FAILED" } | null;
type Plan = { to: string[]; lang: MailLang; from?: string } | { skipped: "NO_EMAIL" | "NOT_CONNECTED" | "FAILED"; error?: string };

/** The posted document: what its print, its recipients and its timeline entry read. */
export type PostedDoc = { DocEntry?: unknown; DocNum?: unknown; CardCode?: unknown; ContactPersonCode?: unknown; DocType?: unknown };
/** What afterPost reads when a post has no representation: createQuote's update and dedup paths. */
const POSTED_SELECT = ["DocEntry", "DocNum", "CardCode", "ContactPersonCode", "DocType"];

/** During the request: the document if the post had none in hand, then one BP read — so the toast
 *  says whom it goes to before anything is printed. Never throws: the document is posted by now. */
async function plan(p: Post): Promise<[Plan, PostedDoc]> {
  let doc = p.doc;
  try {
    // First: the print and the timeline need it too, mail or not.
    if (doc.CardCode === undefined)
      doc = (await p.b1.readEntity(p.entity, Number(doc.DocEntry), { select: POSTED_SELECT })).data as PostedDoc;
    const [row] = await db.select({ account: documentMail.account, settings: documentMail.settings }).from(documentMail)
      .where(eq(documentMail.tenantId, p.tenantId)).limit(1);
    if (!row?.account) return [{ skipped: "NOT_CONNECTED" }, doc];
    if (typeof doc.CardCode !== "string") return [{ skipped: "NO_EMAIL" }, doc];
    const bp = (await p.b1.readEntity("BusinessPartners", doc.CardCode, { select: ["EmailAddress", "LanguageCode", "ContactEmployees"] })).data;
    const r = recipientsOf(doc, bp as Record<string, unknown>);
    if (!r.to.length) return [{ skipped: "NO_EMAIL" }, doc];
    return [{ ...r, from: row.settings.types[p.entity]?.from }, doc];
  } catch (e) {
    return [{ skipped: "FAILED", error: message(e) }, doc];
  }
}

/** What the console sender sent, newest last — tests read it, as mailer.ts' devOutbox. ponytail:
 *  last 50, in memory. */
export const documentOutbox: { tenantId: string; from: string; to: string[]; subject: string; html: string; attachment: { name: string; size: number } }[] = [];

type Letter = { subject: string; html: string; to: string[]; from?: string; pdf: { name: string; base64: string; size: number } };

/** One Graph sendMail, as the type's Send from (a shared mailbox the account may send as) or the
 *  account itself; Sent Items keeps it. Without the app's secret (dev, tests) it goes to the console. */
async function sendLetter(tenantId: string, l: Letter): Promise<void> {
  const [row] = await db.select({ account: documentMail.account }).from(documentMail)
    .where(eq(documentMail.tenantId, tenantId)).limit(1);
  if (!row?.account) throw new Error(t("DOCUMENT_MAIL_NOT_CONNECTED"));
  if (l.pdf.size >= MAX_PDF) throw new Error(t("DOCUMENT_MAIL_TOO_LARGE", (l.pdf.size / 1024 / 1024).toFixed(1)));
  if (!clientSecret()) {
    documentOutbox.push({ tenantId, from: l.from ?? row.account, to: l.to, subject: l.subject, html: l.html, attachment: { name: l.pdf.name, size: l.pdf.size } });
    if (documentOutbox.length > 50) documentOutbox.shift();
    console.log(`[document mail] ${l.from ?? row.account} -> ${l.to.join(", ")}: ${l.subject} (${l.pdf.name}, ${l.pdf.size} bytes)`);
    return;
  }
  const token = await graphToken(tenantId);
  const res = await fetch(`${GRAPH}/${l.from ? `users/${encodeURIComponent(l.from)}` : "me"}/sendMail`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: l.subject,
        body: { contentType: "HTML", content: l.html },
        toRecipients: l.to.map((address) => ({ emailAddress: { address } })),
        attachments: [{ "@odata.type": "#microsoft.graph.fileAttachment", name: l.pdf.name, contentType: "application/pdf", contentBytes: l.pdf.base64 }],
      },
      saveToSentItems: true,
    }),
  });
  if (res.status === 401) tokens.delete(tenantId);
  if (res.status !== 202) {
    const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(j?.error?.message ?? `Microsoft Graph answered ${res.status}`);
  }
}

/** The projects whose quotations a document descends from (§5.6): their `quoted` events naming one
 *  of `quotations` in this company — a DocEntry means nothing in another. */
export async function projectsOfQuotations(tenantId: string, companyDb: string | null, quotations: number[]): Promise<string[]> {
  if (!quotations.length || !companyDb) return [];
  const rows = await db.selectDistinct({ id: configProject.id }).from(configProjectEvent)
    .innerJoin(configProject, eq(configProject.id, configProjectEvent.projectId))
    .where(and(
      eq(configProjectEvent.tenantId, tenantId), eq(configProjectEvent.kind, "quoted"),
      inArray(sql<number>`(${configProjectEvent.payload}->>'docEntry')::int`, quotations),
      eq(configProject.tenantId, tenantId),
      sql`coalesce(${configProjectEvent.payload}->>'company', ${configProject.b1Company}) = ${companyDb}`,
    ));
  return rows.map((r) => r.id);
}

/** Each of `quotations` (this company) → the configuration that quoted it, by the same `quoted`
 *  events — so a quotation a re-quote replaced still names its configuration. `portalCardCode`: only
 *  that client company's own projects (the portal's fence; staff's configurations stay unnamed). */
export async function configsOfQuotations(tenantId: string, companyDb: string | null, quotations: number[], portalCardCode?: string) {
  const out = new Map<number, { id: string; name: string }>();
  if (!quotations.length || !companyDb) return out;
  const docEntry = sql<number>`(${configProjectEvent.payload}->>'docEntry')::int`;
  const rows = await db.selectDistinct({ docEntry, id: configProject.id, name: configProject.name }).from(configProjectEvent)
    .innerJoin(configProject, eq(configProject.id, configProjectEvent.projectId))
    .where(and(
      eq(configProjectEvent.tenantId, tenantId), eq(configProjectEvent.kind, "quoted"),
      inArray(docEntry, quotations),
      eq(configProject.tenantId, tenantId),
      portalCardCode === undefined ? undefined : eq(configProject.portalCardCode, portalCardCode),
      sql`coalesce(${configProjectEvent.payload}->>'company', ${configProject.b1Company}) = ${companyDb}`,
    ));
  for (const r of rows) out.set(Number(r.docEntry), { id: r.id, name: r.name });
  return out;
}

type Post = {
  tenantId: string; userId: string; b1: B1Transport; companyDb: string | null;
  entity: DocumentMailType; doc: PostedDoc;
  /** the projects the document belongs to — run after the response (a copy walks its sources) */
  projects: () => Promise<string[]>;
};

/**
 * After a post with "Notify the client" on: whom it goes to, read now, and the print, the send and the
 * project side after the response. The project side runs whether or not the mail goes (no email in
 * SAP, Microsoft refuses it): a portal client still finds the document and its PDF on the timeline.
 */
export async function afterPost(p: Post): Promise<MailAnswer> {
  const [pl, doc] = await plan(p);
  background(() => run({ ...p, doc }, pl));
  return "to" in pl ? { to: pl.to } : { skipped: pl.skipped };
}

async function run(p: Post, pl: Plan): Promise<void> {
  const docEntry = Number(p.doc.DocEntry);
  const docNum = p.doc.DocNum === undefined || p.doc.DocNum === null ? null : Number(p.doc.DocNum);
  const cardCode = String(p.doc.CardCode ?? "");
  const failed = (error: string) => notifyMailFailed({ tenantId: p.tenantId, posterId: p.userId, entity: p.entity, docEntry, docNum, cardCode, error });
  const projects = await p.projects().catch((e) => {
    console.error("[document mail] projects", e);
    return [] as string[];
  });
  // Nothing to send and no timeline to put it on: no print either.
  if (!("to" in pl) && !projects.length) return;

  let pdf;
  try {
    // A document the plan could not read: print reads its CardCode and DocType itself.
    pdf = await printDocument(p.tenantId, p.entity, docEntry, p.doc.CardCode === undefined ? undefined : p.doc);
  } catch (e) {
    // A print failure ends the run: no file, no event, no portal notice.
    failed(message(e));
    return;
  }
  const lang = "to" in pl ? pl.lang : "en";
  const num = String(docNum ?? docEntry);
  const { brand } = await tenantBrand(p.tenantId);
  const letter = { brandName: brand.name, entity: p.entity, docNum: num, lang };
  const data = Buffer.from(pdf.pdf, "base64");
  // The customer's own word for it, `Factura 240991.pdf`, for the attachment and the timeline alike.
  const name = `${letterTitle(letter)}.pdf`;

  let to: string[] = [];
  let error: string | undefined = "to" in pl ? undefined : pl.error ?? pl.skipped;
  if ("to" in pl) {
    try {
      await sendLetter(p.tenantId, {
        subject: letterSubject(letter), html: await letterHtml(letter), to: pl.to, from: pl.from,
        pdf: { name, base64: pdf.pdf, size: data.length },
      });
      to = pl.to;
    } catch (e) {
      error = message(e);
      failed(error);
    }
  }
  // After the send, so an entry never claims a mail that did not leave. One entry per project: an
  // order merging two projects' quotations is on both timelines.
  for (const projectId of projects) {
    await addDocumentSent(p.tenantId, projectId, { userId: p.userId, side: "internal" }, { name, data }, {
      entity: p.entity, docEntry, docNum, company: p.companyDb, to, ...(error ? { error } : {}),
    }).catch((e) => console.error(`[document mail] timeline ${projectId}`, e));
  }
}
