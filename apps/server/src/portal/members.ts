import { ORPCError } from "@orpc/server";
import { and, asc, eq, gt, inArray, notInArray, sql } from "drizzle-orm";
import {
  db, EXTERNAL_ROLES, externalRole, invitation, member, organization, PORTAL_ROLES, portalCompany, portalCompanyDomain,
  portalRoleOf, user, type PortalRole,
} from "@confire/db";
import { mailLang } from "../mail/layout.tsx";
import { sendMails } from "../mail/mailer.ts";
import { invitationMail } from "../mail/portal-mail.tsx";
import { portalTenantUrl } from "../tenant.ts";
import { tenantBrand } from "./settings.ts";

// The customer portal's write rules (spec §4.2, §5.1): seats, registered domains and invitations.
// Both processes import this module — the internal app (an admin inviting from a BP, editing a
// company) and the portal (accept, auto-join, an owner inviting colleagues) — so the two sides
// cannot enforce different rules.
//
// A seat is a Better Auth `member` row of the supplier's organization whose role is its role in its
// company (`portal_buyer`, externalRole) and whose `cardCode` is that company (spec
// 2026-10-19-path-tenancy-design.md). A company is (organization, CardCode): a CardCode alone is
// another supplier's company too, so every match below carries the organization with it.
// An invitation is Better Auth's `invitation` row with the same two.
// One member row per (organization, user) is what makes staff and customer of one tenant exclusive,
// and "one company per user per tenant" — this module writes external rows directly, never through
// Better Auth's endpoints (auth.ts turns those off).

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The member's company: its CardCode in the member's own organization. */
const seatCompany = and(eq(portalCompany.tenantId, member.organizationId), eq(portalCompany.cardCode, member.cardCode));
const portalRole = portalRoleOf(member.role);
const isExternal = inArray(member.role, EXTERNAL_ROLES);

/** Every supplier this user has a seat at, by supplier name: the sign-in dispatcher's portal rows
 *  (internal `sap.lobby`) and the portal shell's "Switch supplier" (portal `lobby`). */
export const portalSeats = (userId: string) =>
  db
    .select({
      tenantId: organization.id, slug: organization.slug, tenantName: organization.name, logo: organization.logo,
      cardName: portalCompany.cardName, role: portalRole,
    })
    .from(member)
    .innerJoin(portalCompany, seatCompany)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.userId, userId), isExternal))
    .orderBy(asc(organization.name));

const INVITATION_DAYS = 14;

// ponytail: the big consumer providers by hand; check against a maintained list (HubSpot's
// free-email-domains) when a customer turns up on one that is missing here.
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "outlook.de", "hotmail.com", "hotmail.de", "hotmail.co.uk",
  "live.com", "live.de", "msn.com", "yahoo.com", "yahoo.de", "yahoo.co.uk", "ymail.com", "icloud.com", "me.com",
  "mac.com", "aol.com", "aol.de", "gmx.de", "gmx.net", "gmx.at", "gmx.ch", "gmx.com", "web.de", "t-online.de",
  "freenet.de", "posteo.de", "mailbox.org", "proton.me", "protonmail.com", "pm.me", "tutanota.com", "tuta.io",
  "yandex.com", "yandex.ru", "mail.ru", "mail.com", "zoho.com", "fastmail.com", "libero.it", "orange.fr",
  "free.fr", "laposte.net", "wanadoo.fr", "bluewin.ch", "seznam.cz", "wp.pl", "o2.pl", "interia.pl", "qq.com", "163.com",
]);

export const emailDomain = (email: string) => email.slice(email.lastIndexOf("@") + 1).trim().toLowerCase();

/** A domain anyone can get an address on: never auto-joins, never registered to a company. */
export const isFreeMail = (domain: string) => FREE_MAIL.has(domain.trim().toLowerCase());

/** Works for this supplier: a membership of its organization that is not a customer's. */
export async function isInternalMember(tenantId: string, userId: string): Promise<boolean> {
  const [row] = await db.select({ id: member.id }).from(member)
    .where(and(eq(member.organizationId, tenantId), eq(member.userId, userId), notInArray(member.role, EXTERNAL_ROLES))).limit(1);
  return !!row;
}

/** This user's seat at the supplier, or undefined. */
export async function seatOf(tenantId: string, userId: string) {
  const [seat] = await db
    .select({
      cardCode: portalCompany.cardCode, cardName: portalCompany.cardName, cardType: portalCompany.cardType,
      role: portalRole,
    })
    .from(member)
    .innerJoin(portalCompany, seatCompany)
    .where(and(eq(member.organizationId, tenantId), eq(member.userId, userId), isExternal))
    .limit(1);
  return seat;
}

const RANK: Record<PortalRole, number> = { viewer: 0, buyer: 1, owner: 2 };

/**
 * The only writer of an external member row (auto-join, invitation accept, onboarding submit). The
 * user's one membership of this organization decides: staff is FORBIDDEN, a seat at another company
 * here is a CONFLICT, and a second way into the SAME company (an auto-joined viewer then accepting a
 * buyer invitation) raises the role and never lowers it, so it can never take a company's last owner
 * away. The user row is locked first: the generated Better Auth schema cannot carry a unique
 * (organizationId, userId) index, so this lock is what keeps two concurrent joins from both inserting.
 */
export async function addPortalMember(tx: Tx, m: { tenantId: string; cardCode: string; userId: string; role: PortalRole }) {
  await tx.select({ id: user.id }).from(user).where(eq(user.id, m.userId)).for("update");
  const [row] = await tx.select({ id: member.id, role: member.role, cardCode: member.cardCode })
    .from(member).where(and(eq(member.organizationId, m.tenantId), eq(member.userId, m.userId))).limit(1);
  if (!row) {
    await tx.insert(member).values({
      id: crypto.randomUUID(), organizationId: m.tenantId, userId: m.userId, role: externalRole(m.role),
      cardCode: m.cardCode, createdAt: new Date(),
    });
    return;
  }
  const current = PORTAL_ROLES.find((r) => externalRole(r) === row.role);
  if (!current) {
    throw new ORPCError("FORBIDDEN", { message: "This account works for the supplier: staff use its internal app, not the portal" });
  }
  if (row.cardCode !== m.cardCode) {
    throw new ORPCError("CONFLICT", { message: "This account already belongs to another company on this portal" });
  }
  if (RANK[m.role] > RANK[current]) await tx.update(member).set({ role: externalRole(m.role) }).where(eq(member.id, row.id));
}

/** Registers `domain` to the company — the auto-join index. Free mail is never registered, and a
 *  domain already registered to another company stays where it is: the caller learns its CardCode. */
export async function claimDomain(
  tx: Tx, d: { tenantId: string; cardCode: string; domain: string; addedBy: string | null },
): Promise<"added" | "free" | { takenBy: string }> {
  const domain = d.domain.trim().toLowerCase();
  if (isFreeMail(domain)) return "free";
  await tx.insert(portalCompanyDomain).values({ ...d, domain }).onConflictDoNothing();
  const [holder] = await tx.select({ cardCode: portalCompanyDomain.cardCode }).from(portalCompanyDomain)
    .where(and(eq(portalCompanyDomain.tenantId, d.tenantId), eq(portalCompanyDomain.domain, domain)));
  return holder!.cardCode === d.cardCode ? "added" : { takenBy: holder!.cardCode };
}

/**
 * Changes a member's role, or removes them (`role: null`). A change that would leave a company that
 * has an owner with none is refused, on both sides (decided 2026-10-16): make someone else owner
 * first. The company's owner rows are locked FOR UPDATE, so two owners demoting each other at once
 * run one after the other, and the second sees the first's result.
 */
export async function changeMember(c: { tenantId: string; cardCode: string; userId: string; role: PortalRole | null }) {
  await db.transaction(async (tx) => {
    const fence = and(eq(member.organizationId, c.tenantId), isExternal, eq(member.cardCode, c.cardCode));
    const owners = await tx.select({ userId: member.userId }).from(member)
      .where(and(fence, eq(member.role, externalRole("owner")))).for("update");
    const [target] = await tx.select({ role: portalRole }).from(member)
      .where(and(fence, eq(member.userId, c.userId)));
    if (!target) throw new ORPCError("NOT_FOUND", { message: "No such member in this company" });
    const lastOwner = target.role === "owner" && owners.length === 1 && owners[0]!.userId === c.userId;
    if (lastOwner && c.role !== "owner") {
      throw new ORPCError("CONFLICT", { message: "A company needs at least one owner: make someone else owner first" });
    }
    if (c.role === null) await tx.delete(member).where(and(fence, eq(member.userId, c.userId)));
    else await tx.update(member).set({ role: externalRole(c.role) }).where(and(fence, eq(member.userId, c.userId)));
  });
}

/** Spec §5.1's guard, checked on send: not the supplier's staff, not in another company here, not
 *  already in this one. A new-client invitation (`cardCode` null) is refused for anyone in a company
 *  here: the message names its CardCode, so the sender uses *Invite to portal* on that BP instead. */
async function inviteGuard(tenantId: string, cardCode: string | null, email: string) {
  const [u] = await db.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${email}`).limit(1);
  if (!u) return;
  if (await isInternalMember(tenantId, u.id)) {
    throw new ORPCError("FORBIDDEN", { message: `${email} works for you: staff use the internal app, not the portal` });
  }
  const seat = await seatOf(tenantId, u.id);
  if (!seat) return;
  throw new ORPCError("CONFLICT", {
    message: seat.cardCode === cardCode
      ? `${email} is already a member of ${seat.cardName}`
      : `${email} already belongs to ${seat.cardName} (${seat.cardCode}) on your portal`,
  });
}

/** This tenant's portal invitations: Better Auth's rows with a `portal_*` role (a staff invitation, if
 *  one is ever written, is none of the portal's business). */
export const portalInvitationOf = (tenantId: string) =>
  and(eq(invitation.organizationId, tenantId), inArray(invitation.role, EXTERNAL_ROLES));

/** Pending and not expired: an expired invitation keeps `pending` (Better Auth's own rule), so only
 *  this pair means "open". */
export const openInvitation = () => and(eq(invitation.status, "pending"), gt(invitation.expiresAt, new Date()));

/**
 * An invitation (spec §5.1): guard → lock the organization → refuse a second open invitation for the
 * address → insert → mail, after commit and off the request path. Re-sending is cancel + a new
 * invitation. The organization row lock is the "one open invitation per address" rule: the generated
 * Better Auth schema cannot carry the partial unique index, so two concurrent sends run one after the
 * other and the second sees the first. `cardCode` null is a new-client invitation (D25): its invitee
 * fills the onboarding form, and its submit sets the company. The mail is in the company's SAP
 * language; a new client has none yet, so it is `languageCode`, the inviter's (and its lead's, later).
 */
export async function sendInvitation(i: {
  tenantId: string; cardCode: string | null; email: string; role: PortalRole; registerDomain: boolean;
  inviter: { id: string; name: string; email: string };
  /** a new client's SAP language (UserLanguages.Code); an existing company's own is read here */
  languageCode?: number;
}): Promise<{ id: string; expiresAt: Date }> {
  const email = i.email.trim().toLowerCase();
  const { slug, brand } = await tenantBrand(i.tenantId);
  const [company] = i.cardCode === null ? [null] : await db
    .select({ cardName: portalCompany.cardName, languageCode: portalCompany.languageCode }).from(portalCompany)
    .where(and(eq(portalCompany.tenantId, i.tenantId), eq(portalCompany.cardCode, i.cardCode)));
  if (company === undefined) throw new ORPCError("NOT_FOUND", { message: "No such company on this portal" });
  const languageCode = company ? company.languageCode : (i.languageCode ?? null);
  await inviteGuard(i.tenantId, i.cardCode, email);

  const expiresAt = new Date(Date.now() + INVITATION_DAYS * 86_400_000);
  const id = await db.transaction(async (tx) => {
    await tx.select({ id: organization.id }).from(organization).where(eq(organization.id, i.tenantId)).for("update");
    const [taken] = await tx.select({ cardCode: invitation.cardCode, cardName: portalCompany.cardName })
      .from(invitation)
      .leftJoin(portalCompany, and(eq(portalCompany.tenantId, invitation.organizationId), eq(portalCompany.cardCode, invitation.cardCode)))
      .where(and(portalInvitationOf(i.tenantId), eq(invitation.email, email), openInvitation()))
      .limit(1);
    if (taken) {
      const to = taken.cardCode ? ` to ${taken.cardName} (${taken.cardCode})` : " as a new client";
      throw new ORPCError("CONFLICT", { message: `${email} already has an open invitation${to}: cancel it to send a new one` });
    }
    const id = crypto.randomUUID();
    await tx.insert(invitation).values({
      id, organizationId: i.tenantId, email, role: externalRole(i.role), status: "pending", expiresAt,
      inviterId: i.inviter.id, cardCode: i.cardCode, registerDomain: i.registerDomain, languageCode,
    });
    return id;
  });

  // Client-facing: from <slug>@mail.<domain>, off the request path.
  const mail = invitationMail({
    id, to: email, inviterName: i.inviter.name,
    companyName: company?.cardName ?? null, brand, url: portalTenantUrl(slug, `/accept/${id}`), expiresAt,
    lang: mailLang(languageCode),
  });
  void sendMails([mail], `invite/${id}`).then((r) => {
    if (r.error) console.error(`[mail] invitation ${id} -> ${email} failed: ${r.error}`);
  });
  return { id, expiresAt };
}

/** pending → canceled, for these ids on this tenant — and this company, when named (an owner may
 *  cancel only their own company's). Returns how many it cancelled. */
export async function cancelInvitations(tenantId: string, ids: string[], cardCode?: string): Promise<number> {
  if (!ids.length) return 0;
  const rows = await db.update(invitation).set({ status: "canceled" })
    .where(and(
      portalInvitationOf(tenantId), inArray(invitation.id, ids), eq(invitation.status, "pending"),
      cardCode ? eq(invitation.cardCode, cardCode) : undefined,
    ))
    .returning({ id: invitation.id });
  return rows.length;
}

/** Who is in a company, who is invited, and which domains auto-join it — the BP Object Page's Portal
 *  section and the owner's company page read the same lists. */
export async function companyPeople(tenantId: string, cardCode: string) {
  const [members, invitations, domains] = await Promise.all([
    db.select({ userId: member.userId, name: user.name, email: user.email, role: portalRole, createdAt: member.createdAt })
      .from(member).innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.organizationId, tenantId), isExternal, eq(member.cardCode, cardCode))).orderBy(asc(member.createdAt)),
    db.select({
      id: invitation.id, email: invitation.email, role: portalRoleOf(invitation.role),
      expiresAt: invitation.expiresAt, expired: sql<boolean>`${invitation.expiresAt} < now()`,
    })
      .from(invitation)
      .where(and(portalInvitationOf(tenantId), eq(invitation.cardCode, cardCode), eq(invitation.status, "pending")))
      .orderBy(asc(invitation.createdAt)),
    db.select({ domain: portalCompanyDomain.domain, addedAt: portalCompanyDomain.addedAt })
      .from(portalCompanyDomain)
      .where(and(eq(portalCompanyDomain.tenantId, tenantId), eq(portalCompanyDomain.cardCode, cardCode)))
      .orderBy(asc(portalCompanyDomain.domain)),
  ]);
  return { members, invitations, domains };
}
