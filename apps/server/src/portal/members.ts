import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import {
  db, member, organization, portalCompany, portalCompanyDomain, portalInvitation, portalMember, user, type PortalRole,
} from "@confire/db";
import { sendMailInBackground } from "../mail/mailer.ts";
import { invitationMail } from "../mail/portal-mail.tsx";
import { portalTenantUrl } from "../tenant.ts";

// The customer portal's write rules (spec §4.2, §5.1): seats, registered domains and invitations.
// Both processes import this module — the internal app (an admin inviting from a BP, editing a
// company) and the portal (accept, auto-join, an owner inviting colleagues) — so the two sides
// cannot enforce different rules. It never touches Better Auth.

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Every supplier this user has a seat at, by supplier name: the sign-in dispatcher's portal rows
 *  (internal `sap.lobby`) and the portal shell's "Switch supplier" (portal `lobby`). */
export const portalSeats = (userId: string) =>
  db
    .select({
      slug: organization.slug, tenantName: organization.name, logo: organization.logo,
      cardName: portalCompany.cardName, role: portalMember.role,
    })
    .from(portalMember)
    .innerJoin(portalCompany, eq(portalCompany.id, portalMember.companyId))
    .innerJoin(organization, eq(organization.id, portalCompany.tenantId))
    .where(eq(portalMember.userId, userId))
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

/** Postgres unique_violation on one named constraint. node-postgres puts `code`/`constraint` on its
 *  error, which drizzle 0.45 wraps as `cause`, so the chain is walked. */
const violated = (e: unknown, constraint: string): boolean => {
  for (let x = e as { code?: string; constraint?: string; cause?: unknown } | undefined; x; x = x.cause as typeof x) {
    if (x.code === "23505" && x.constraint === constraint) return true;
  }
  return false;
};

/** Works for this supplier: an internal membership. A leftover `client` row (the removed in-app
 *  portal) is not staff — it stays locked out of the internal app, and the portal does not read it
 *  (spec D23), so its owner is a customer here like any other. */
export async function isInternalMember(tenantId: string, userId: string, q: typeof db | Tx = db): Promise<boolean> {
  const [row] = await q.select({ id: member.id }).from(member)
    .where(and(eq(member.organizationId, tenantId), eq(member.userId, userId), ne(member.role, "client"))).limit(1);
  return !!row;
}

/** This user's seat at the supplier, or undefined. */
export async function seatOf(tenantId: string, userId: string) {
  const [seat] = await db
    .select({
      companyId: portalCompany.id, cardCode: portalCompany.cardCode, cardName: portalCompany.cardName,
      cardType: portalCompany.cardType, role: portalMember.role,
    })
    .from(portalMember)
    .innerJoin(portalCompany, eq(portalCompany.id, portalMember.companyId))
    .where(and(eq(portalMember.userId, userId), eq(portalCompany.tenantId, tenantId)))
    .limit(1);
  return seat;
}

/**
 * The only insert into portal_member (auto-join, invitation accept, onboarding submit). Refuses the
 * supplier's own staff. The unique (tenantId, userId) index is "one company per user per tenant",
 * so a seat at another company here — even one won by a concurrent request — is a CONFLICT.
 * A second way into the SAME company (an auto-joined viewer then accepting a buyer invitation)
 * raises the role and never lowers it, so it can never take a company's last owner away.
 */
export async function addPortalMember(tx: Tx, m: { tenantId: string; companyId: string; userId: string; role: PortalRole }) {
  if (await isInternalMember(m.tenantId, m.userId, tx)) {
    throw new ORPCError("FORBIDDEN", { message: "This account works for the supplier: staff use its internal app, not the portal" });
  }
  try {
    await tx.insert(portalMember).values(m).onConflictDoUpdate({
      target: [portalMember.companyId, portalMember.userId],
      set: {
        role: sql`case when excluded.role = 'owner' or (excluded.role = 'buyer' and ${portalMember.role} = 'viewer')
          then excluded.role else ${portalMember.role} end`,
      },
    });
  } catch (e) {
    if (violated(e, "portal_member_tenant_user_uq")) {
      throw new ORPCError("CONFLICT", { message: "This account already belongs to another company on this portal" });
    }
    throw e;
  }
}

/** Registers `domain` to the company — the auto-join index. Free mail is never registered, and a
 *  domain already registered to another company stays where it is: the caller learns its CardCode. */
export async function claimDomain(
  tx: Tx, d: { tenantId: string; companyId: string; domain: string; addedBy: string | null },
): Promise<"added" | "free" | { takenBy: string }> {
  const domain = d.domain.trim().toLowerCase();
  if (isFreeMail(domain)) return "free";
  await tx.insert(portalCompanyDomain).values({ ...d, domain }).onConflictDoNothing();
  const [holder] = await tx.select({ companyId: portalCompanyDomain.companyId, cardCode: portalCompany.cardCode })
    .from(portalCompanyDomain)
    .innerJoin(portalCompany, eq(portalCompany.id, portalCompanyDomain.companyId))
    .where(and(eq(portalCompanyDomain.tenantId, d.tenantId), eq(portalCompanyDomain.domain, domain)));
  return holder!.companyId === d.companyId ? "added" : { takenBy: holder!.cardCode };
}

/**
 * Changes a member's role, or removes them (`role: null`). A change that would leave a company that
 * has an owner with none is refused, on both sides (decided 2026-10-16): make someone else owner
 * first. The company's owner rows are locked FOR UPDATE, so two owners demoting each other at once
 * run one after the other, and the second sees the first's result.
 */
export async function changeMember(c: { tenantId: string; companyId: string; userId: string; role: PortalRole | null }) {
  await db.transaction(async (tx) => {
    const fence = and(eq(portalMember.companyId, c.companyId), eq(portalMember.tenantId, c.tenantId));
    const owners = await tx.select({ userId: portalMember.userId }).from(portalMember)
      .where(and(fence, eq(portalMember.role, "owner"))).for("update");
    const [target] = await tx.select({ role: portalMember.role }).from(portalMember)
      .where(and(fence, eq(portalMember.userId, c.userId)));
    if (!target) throw new ORPCError("NOT_FOUND", { message: "No such member in this company" });
    const lastOwner = target.role === "owner" && owners.length === 1 && owners[0]!.userId === c.userId;
    if (lastOwner && c.role !== "owner") {
      throw new ORPCError("CONFLICT", { message: "A company needs at least one owner: make someone else owner first" });
    }
    if (c.role === null) await tx.delete(portalMember).where(and(fence, eq(portalMember.userId, c.userId)));
    else await tx.update(portalMember).set({ role: c.role }).where(and(fence, eq(portalMember.userId, c.userId)));
  });
}

/** Spec §5.1's guard, checked on send against Confire's own tables: not the supplier's staff, not in
 *  another company here (accept would fail on the unique index anyway), not already in this one. A
 *  new-client invitation (`companyId` null) is refused for anyone in a company here: the message
 *  names its CardCode, so the sender uses *Invite to portal* on that BP instead. */
async function inviteGuard(tenantId: string, companyId: string | null, email: string) {
  const [u] = await db.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${email}`).limit(1);
  if (!u) return;
  if (await isInternalMember(tenantId, u.id)) {
    throw new ORPCError("FORBIDDEN", { message: `${email} works for you: staff use the internal app, not the portal` });
  }
  const seat = await seatOf(tenantId, u.id);
  if (!seat) return;
  throw new ORPCError("CONFLICT", {
    message: seat.companyId === companyId
      ? `${email} is already a member of ${seat.cardName}`
      : `${email} already belongs to ${seat.cardName} (${seat.cardCode}) on your portal`,
  });
}

/** An open invitation for this address, named for the refusal message. */
async function openInvitation(tenantId: string, email: string) {
  const [row] = await db
    .select({ cardCode: portalCompany.cardCode, cardName: portalCompany.cardName, createdAt: portalInvitation.createdAt })
    .from(portalInvitation)
    .leftJoin(portalCompany, eq(portalCompany.id, portalInvitation.companyId))
    .where(and(eq(portalInvitation.tenantId, tenantId), sql`lower(${portalInvitation.email}) = ${email}`, eq(portalInvitation.status, "pending")))
    .limit(1);
  return row;
}

/**
 * An invitation (spec §5.1): guard → cancel this address's expired invitations (they are still
 * `pending`, and the partial unique index would block every re-invite) → insert → mail, after commit
 * and off the request path. Re-sending is cancel + a new invitation: the index allows one open
 * invitation per address and tenant, and is the backstop when two sends race. `companyId` null is a
 * new-client invitation (D25): its invitee fills the onboarding form, and its submit sets the company.
 */
export async function sendInvitation(i: {
  tenantId: string; companyId: string | null; email: string; role: PortalRole; registerDomain: boolean;
  inviter: { id: string; name: string; email: string };
}): Promise<{ id: string; expiresAt: Date }> {
  const email = i.email.trim().toLowerCase();
  const [tenant] = await db.select({ slug: organization.slug, name: organization.name, logo: organization.logo })
    .from(organization).where(eq(organization.id, i.tenantId));
  const [company] = i.companyId === null ? [null] : await db.select({ cardName: portalCompany.cardName }).from(portalCompany)
    .where(and(eq(portalCompany.id, i.companyId), eq(portalCompany.tenantId, i.tenantId)));
  if (!tenant || company === undefined) throw new ORPCError("NOT_FOUND", { message: "No such company on this portal" });
  await inviteGuard(i.tenantId, i.companyId, email);

  const expiresAt = new Date(Date.now() + INVITATION_DAYS * 86_400_000);
  let id: string;
  try {
    id = await db.transaction(async (tx) => {
      await tx.update(portalInvitation).set({ status: "canceled" }).where(and(
        eq(portalInvitation.tenantId, i.tenantId), sql`lower(${portalInvitation.email}) = ${email}`,
        eq(portalInvitation.status, "pending"), lt(portalInvitation.expiresAt, new Date()),
      ));
      const [row] = await tx.insert(portalInvitation).values({
        tenantId: i.tenantId, companyId: i.companyId, email, role: i.role, invitedBy: i.inviter.id,
        registerDomain: i.registerDomain, expiresAt,
      }).returning({ id: portalInvitation.id });
      return row!.id;
    });
  } catch (e) {
    if (!violated(e, "portal_invitation_pending_uq")) throw e;
    const open = await openInvitation(i.tenantId, email);
    const to = open?.cardCode ? ` to ${open.cardName} (${open.cardCode})` : open ? " as a new client" : "";
    throw new ORPCError("CONFLICT", { message: `${email} already has an open invitation${to}: cancel it to send a new one` });
  }

  sendMailInBackground(invitationMail({
    id, to: email, inviterEmail: i.inviter.email, inviterName: i.inviter.name, companyName: company?.cardName ?? null,
    brand: { name: tenant.name, logoUrl: tenant.logo }, url: portalTenantUrl(tenant.slug, `/accept/${id}`), expiresAt,
  }));
  return { id, expiresAt };
}

/** pending → canceled, for these ids on this tenant — and this company, when named (an owner may
 *  cancel only their own company's). Returns how many it cancelled. */
export async function cancelInvitations(tenantId: string, ids: string[], companyId?: string): Promise<number> {
  if (!ids.length) return 0;
  const rows = await db.update(portalInvitation).set({ status: "canceled" })
    .where(and(
      eq(portalInvitation.tenantId, tenantId), inArray(portalInvitation.id, ids), eq(portalInvitation.status, "pending"),
      companyId ? eq(portalInvitation.companyId, companyId) : undefined,
    ))
    .returning({ id: portalInvitation.id });
  return rows.length;
}

/** Who is in a company, who is invited, and which domains auto-join it — the BP Object Page's Portal
 *  section and the owner's company page read the same lists. */
export async function companyPeople(companyId: string) {
  const [members, invitations, domains] = await Promise.all([
    db.select({ userId: portalMember.userId, name: user.name, email: user.email, role: portalMember.role, createdAt: portalMember.createdAt })
      .from(portalMember).innerJoin(user, eq(user.id, portalMember.userId))
      .where(eq(portalMember.companyId, companyId)).orderBy(asc(portalMember.createdAt)),
    db.select({
      id: portalInvitation.id, email: portalInvitation.email, role: portalInvitation.role,
      expiresAt: portalInvitation.expiresAt, expired: sql<boolean>`${portalInvitation.expiresAt} < now()`,
    })
      .from(portalInvitation)
      .where(and(eq(portalInvitation.companyId, companyId), eq(portalInvitation.status, "pending")))
      .orderBy(asc(portalInvitation.createdAt)),
    db.select({ domain: portalCompanyDomain.domain, addedAt: portalCompanyDomain.addedAt })
      .from(portalCompanyDomain).where(eq(portalCompanyDomain.companyId, companyId)).orderBy(asc(portalCompanyDomain.domain)),
  ]);
  return { members, invitations, domains };
}
