import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, PORTAL_ROLES, portalCompany, portalCompanyDomain, portalInvitation, user, type PortalCardType } from "@confire/db";
import { adminProcedure } from "../base.ts";
import { tenantConnector, viaB1 } from "../../b1.ts";
import { compileQuery, listPage, ListPageZ, TOTAL, type SqlFields } from "../../list-sql.ts";
import { cancelInvitations, changeMember, claimDomain, companyPeople, isFreeMail, sendInvitation } from "../../portal/members.ts";

// The internal app's side of the customer portal (spec §5.1, §10, §11): invite a business partner's
// people (existing-BP invitations, from its Object Page), list and cancel invitations, and edit who
// is on the portal for a CardCode. Admins and owners only — the server says so, not which buttons
// a page draws. The rules themselves live in portal/members.ts, shared with the portal process.

const RoleZ = z.enum(PORTAL_ROLES);
const CardCodeZ = z.string().trim().min(1).max(50);
const DomainZ = z.string().trim().toLowerCase().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "Enter a domain such as kunde.de");

/** A pending invitation past its expiry still reads `pending` in the table; lists show `expired`. */
const STATE = sql<"pending" | "accepted" | "canceled" | "expired">`case when ${portalInvitation.status} = 'pending'
  and ${portalInvitation.expiresAt} < now() then 'expired' else ${portalInvitation.status} end`;

const INVITATION_FIELDS: SqlFields = {
  email: { col: portalInvitation.email, kind: "string" },
  cardCode: { col: portalCompany.cardCode, kind: "string" },
  cardName: { col: portalCompany.cardName, kind: "string" },
  role: { col: portalInvitation.role, kind: "enum" },
  state: { col: STATE, kind: "enum" },
  inviter: { col: user.name, kind: "string" },
  expiresAt: { col: portalInvitation.expiresAt, kind: "date" },
  createdAt: { col: portalInvitation.createdAt, kind: "date" },
};

/** This tenant's company for a CardCode — the fence for every company edit below. */
async function companyOf(tenantId: string, cardCode: string) {
  const [c] = await db.select().from(portalCompany)
    .where(and(eq(portalCompany.tenantId, tenantId), eq(portalCompany.cardCode, cardCode))).limit(1);
  return c;
}

async function requireCompany(tenantId: string, cardCode: string) {
  const c = await companyOf(tenantId, cardCode);
  if (!c) throw new ORPCError("NOT_FOUND", { message: `${cardCode} is not on the portal yet: invite someone first` });
  return c;
}

export const portalInvitationsRouter = {
  /** Portal → Invitations: every invitation of the tenant, both types (a new-client one has no
   *  CardCode until its form is submitted). */
  rows: adminProcedure.input(ListPageZ).handler(async ({ input, context }) => {
    const { where, orderBy } = compileQuery(INVITATION_FIELDS, input.query);
    const raw = await db
      .select({
        id: portalInvitation.id, email: portalInvitation.email, cardCode: portalCompany.cardCode,
        cardName: portalCompany.cardName, role: portalInvitation.role, state: STATE, inviter: user.name,
        expiresAt: portalInvitation.expiresAt, createdAt: portalInvitation.createdAt, _total: TOTAL,
      })
      .from(portalInvitation)
      .leftJoin(portalCompany, eq(portalCompany.id, portalInvitation.companyId))
      .leftJoin(user, eq(user.id, portalInvitation.invitedBy))
      .where(and(eq(portalInvitation.tenantId, context.tenantId), where))
      // `id` last so the order is total — OFFSET paging over a non-unique sort skips rows.
      .orderBy(...orderBy, desc(portalInvitation.createdAt), portalInvitation.id)
      .limit(input.top)
      .offset(input.skip ?? 0);
    return listPage(raw, input.top, input.skip);
  }),

  /** *Invite to portal* on the BP Object Page. The BP is re-read from SAP first: customers and leads
   *  qualify, and its company row is found or created with the name and type SAP has now. */
  inviteExisting: adminProcedure
    .input(z.object({ cardCode: CardCodeZ, email: z.email(), role: RoleZ, registerDomain: z.boolean() }))
    .handler(async ({ input, context }) => {
      const { b1 } = await tenantConnector(context.tenantId);
      const { data } = await viaB1(() =>
        b1.readEntity("BusinessPartners", input.cardCode, { select: ["CardCode", "CardName", "CardType"] }));
      const bp = data as { CardCode: string; CardName: string | null; CardType: string };
      if (bp.CardType !== "cCustomer" && bp.CardType !== "cLid") {
        throw new ORPCError("BAD_REQUEST", { message: `${bp.CardCode} is not a customer or a lead: only those can use the portal` });
      }
      const fresh = { cardName: bp.CardName ?? bp.CardCode, cardType: bp.CardType as PortalCardType };
      const [company] = await db.insert(portalCompany)
        .values({ tenantId: context.tenantId, cardCode: bp.CardCode, ...fresh })
        .onConflictDoUpdate({ target: [portalCompany.tenantId, portalCompany.cardCode], set: fresh })
        .returning({ id: portalCompany.id });
      return sendInvitation({
        tenantId: context.tenantId, companyId: company!.id, email: input.email, role: input.role,
        registerDomain: input.registerDomain,
        inviter: { id: context.user.id, name: context.user.name, email: context.user.email },
      });
    }),

  cancel: adminProcedure
    .input(z.object({ ids: z.array(z.uuid()).min(1).max(500) }))
    .handler(async ({ input, context }) => ({ canceled: await cancelInvitations(context.tenantId, input.ids) })),
};

export const portalCompaniesRouter = {
  /** The BP Object Page's Portal section: who is on the portal for this CardCode, who is invited,
   *  and which email domains auto-join it. `company: null` = not on the portal yet. */
  get: adminProcedure.input(z.object({ cardCode: CardCodeZ })).handler(async ({ input, context }) => {
    const company = await companyOf(context.tenantId, input.cardCode);
    if (!company) return { company: null, members: [], invitations: [], domains: [] };
    return { company: { id: company.id, cardName: company.cardName, cardType: company.cardType }, ...(await companyPeople(company.id)) };
  }),

  setRole: adminProcedure
    .input(z.object({ cardCode: CardCodeZ, userId: z.string().min(1), role: RoleZ }))
    .handler(async ({ input, context }) => {
      const c = await requireCompany(context.tenantId, input.cardCode);
      await changeMember({ tenantId: context.tenantId, companyId: c.id, userId: input.userId, role: input.role });
    }),

  removeMember: adminProcedure
    .input(z.object({ cardCode: CardCodeZ, userId: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const c = await requireCompany(context.tenantId, input.cardCode);
      await changeMember({ tenantId: context.tenantId, companyId: c.id, userId: input.userId, role: null });
    }),

  /** Register an email domain to the company: a verified sign-in on it joins as viewer (spec §4.4).
   *  Internal users only — a company cannot claim a domain itself. */
  addDomain: adminProcedure
    .input(z.object({ cardCode: CardCodeZ, domain: DomainZ }))
    .handler(async ({ input, context }) => {
      if (isFreeMail(input.domain)) {
        throw new ORPCError("BAD_REQUEST", { message: `${input.domain} is a free-mail domain: anyone can get an address there` });
      }
      const c = await requireCompany(context.tenantId, input.cardCode);
      const res = await db.transaction((tx) =>
        claimDomain(tx, { tenantId: context.tenantId, companyId: c.id, domain: input.domain, addedBy: context.user.id }));
      if (typeof res === "object") {
        throw new ORPCError("CONFLICT", { message: `${input.domain} is already registered to ${res.takenBy}` });
      }
      return { domain: input.domain };
    }),

  removeDomain: adminProcedure
    .input(z.object({ cardCode: CardCodeZ, domain: DomainZ }))
    .handler(async ({ input, context }) => {
      const c = await requireCompany(context.tenantId, input.cardCode);
      await db.delete(portalCompanyDomain).where(and(
        eq(portalCompanyDomain.tenantId, context.tenantId), eq(portalCompanyDomain.domain, input.domain),
        eq(portalCompanyDomain.companyId, c.id),
      ));
    }),
};
