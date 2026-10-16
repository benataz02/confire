import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq, gt } from "drizzle-orm";
import { db, portalCompany, portalCompanyDomain, portalInvitation, user } from "@confire/db";
import { portalSessionProcedure } from "./base.ts";
import { addPortalMember, claimDomain, emailDomain, isFreeMail } from "../members.ts";

// The two ways into a company (spec §4.4, §5.2): an invitation, accepted on its link, and auto-join
// by a registered email domain. Both run on the supplier's host — the auth endpoints live on the
// apex, where there is no tenant — and both end in addPortalMember. The session builder already
// refuses the supplier's own staff.

/** `anna@kunde.de` → `a…@kunde.de`: enough for the right person to recognise, no more. */
const mask = (email: string) => `${email[0]}…${email.slice(email.lastIndexOf("@"))}`;

/** What Better Auth's acceptInvitation checks (pending, not expired, the same email ignoring case,
 *  a verified address), plus that the invitation is this host's supplier's (spec §5.2). Holding the
 *  link is not enough: it has to be the invitee who opens it. */
async function openInvitationFor(tenantId: string, u: { email: string; emailVerified: boolean }, id: string) {
  const [inv] = await db
    .select({
      id: portalInvitation.id, companyId: portalInvitation.companyId, email: portalInvitation.email,
      role: portalInvitation.role, status: portalInvitation.status, expiresAt: portalInvitation.expiresAt,
      registerDomain: portalInvitation.registerDomain, invitedBy: portalInvitation.invitedBy,
      companyName: portalCompany.cardName, inviterName: user.name,
    })
    .from(portalInvitation)
    .leftJoin(portalCompany, eq(portalCompany.id, portalInvitation.companyId))
    .leftJoin(user, eq(user.id, portalInvitation.invitedBy))
    .where(and(eq(portalInvitation.id, id), eq(portalInvitation.tenantId, tenantId)))
    .limit(1);
  if (!inv) throw new ORPCError("NOT_FOUND", { message: "This invitation doesn't exist on this portal" });
  if (inv.email.toLowerCase() !== u.email.toLowerCase()) {
    throw new ORPCError("FORBIDDEN", { message: `This invitation was sent to ${mask(inv.email)}. Sign in with that address to accept it.` });
  }
  if (inv.status === "accepted") throw new ORPCError("CONFLICT", { message: "This invitation has already been accepted" });
  if (inv.status === "canceled") throw new ORPCError("CONFLICT", { message: "This invitation was cancelled. Ask for a new one." });
  if (inv.expiresAt < new Date()) throw new ORPCError("CONFLICT", { message: "This invitation has expired. Ask for a new one." });
  if (!u.emailVerified) throw new ORPCError("FORBIDDEN", { message: "Confirm your email address first, then open the invitation again." });
  return inv;
}

export const onboardingRouter = {
  /** The accept page: what joining means — whose portal, which company, which role, from whom. */
  invitation: portalSessionProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
    const inv = await openInvitationFor(context.tenantId, context.user, input.id);
    return {
      id: inv.id,
      // companyId null = a new-client invitation: the onboarding form (P6), not a join.
      type: inv.companyId ? ("existing" as const) : ("new" as const),
      companyName: inv.companyName,
      role: inv.role,
      inviterName: inv.inviterName,
      tenant: { name: context.tenant.name, slug: context.tenant.slug, logo: context.tenant.logo },
    };
  }),

  /** One transaction: the guarded pending → accepted (a double click loses here), the seat, and the
   *  domain when the inviter asked for it — skipped for free mail or a domain another company has. */
  accept: portalSessionProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
    const inv = await openInvitationFor(context.tenantId, context.user, input.id);
    const companyId = inv.companyId;
    if (!companyId) throw new ORPCError("BAD_REQUEST", { message: "New-client onboarding isn't available yet" });
    await db.transaction(async (tx) => {
      const done = await tx.update(portalInvitation).set({ status: "accepted" })
        .where(and(eq(portalInvitation.id, inv.id), eq(portalInvitation.status, "pending"), gt(portalInvitation.expiresAt, new Date())))
        .returning({ id: portalInvitation.id });
      if (!done.length) throw new ORPCError("CONFLICT", { message: "This invitation has just been accepted or cancelled" });
      await addPortalMember(tx, { tenantId: context.tenantId, companyId, userId: context.user.id, role: inv.role });
      if (inv.registerDomain) {
        await claimDomain(tx, { tenantId: context.tenantId, companyId, domain: emailDomain(inv.email), addedBy: inv.invitedBy });
      }
    });
  }),

  /** Auto-join (spec D5, §4.4): a verified address on a domain registered to a company here joins
   *  it as `viewer`. null when nothing matches — the page then says to ask for an invitation.
   *  ponytail: no `joined` audit event until config_project_event lands (P4); portal_member.createdAt
   *  is the record meanwhile. */
  join: portalSessionProcedure.handler(async ({ context }) => {
    if (!context.user.emailVerified) return null;
    const domain = emailDomain(context.user.email);
    if (isFreeMail(domain)) return null;
    const [hit] = await db.select({ companyId: portalCompany.id, cardName: portalCompany.cardName })
      .from(portalCompanyDomain)
      .innerJoin(portalCompany, eq(portalCompany.id, portalCompanyDomain.companyId))
      .where(and(eq(portalCompanyDomain.tenantId, context.tenantId), eq(portalCompanyDomain.domain, domain)))
      .limit(1);
    if (!hit) return null;
    await db.transaction((tx) =>
      addPortalMember(tx, { tenantId: context.tenantId, companyId: hit.companyId, userId: context.user.id, role: "viewer" }));
    return { cardName: hit.cardName };
  }),
};
