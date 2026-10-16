import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { db, PORTAL_ROLES, portalCompany, portalCompanyDomain, type PortalCardType } from "@confire/db";
import { portalMemberProcedure, portalOwnerProcedure } from "./base.ts";
import { tenantConnector, viaB1 } from "../../b1.ts";
import { cancelInvitations, changeMember, companyPeople, emailDomain, sendInvitation } from "../members.ts";

// The customer's own company page (spec §9, §11): the business partner as SAP has it, colleagues,
// and the registered domains. Everyone with a seat reads; only the owner invites, changes roles and
// removes (D24: invites on the company's own domains only). The company is the caller's seat, so no
// input ever names one.

const SUMMARY_FIELDS = ["CardName", "CardType", "Phone1", "EmailAddress", "Address", "ZipCode", "City", "Country"];

const domainsOf = (companyId: string) =>
  db.select({ domain: portalCompanyDomain.domain }).from(portalCompanyDomain)
    .where(eq(portalCompanyDomain.companyId, companyId)).orderBy(asc(portalCompanyDomain.domain));

export const companyRouter = {
  /** The seat, plus the BP read live from SAP (spec §13). A lead converted in B1 keeps its CardCode,
   *  so only name and type are refreshed (§5.5). SAP being unreachable costs the summary, not the page. */
  get: portalMemberProcedure.handler(async ({ context }) => {
    let summary: Record<string, unknown> | null = null;
    let summaryError: string | null = null;
    try {
      const { b1 } = await tenantConnector(context.tenantId);
      const { data } = await viaB1(() => b1.readEntity("BusinessPartners", context.cardCode, { select: SUMMARY_FIELDS }));
      const row = data as Record<string, unknown>;
      summary = Object.fromEntries(SUMMARY_FIELDS.map((f) => [f, row[f] ?? null]));
    } catch (e) {
      summaryError = e instanceof Error ? e.message : String(e);
    }
    let { cardName, cardType } = context;
    if (summary) {
      const type = summary.CardType === "cCustomer" || summary.CardType === "cLid" ? (summary.CardType as PortalCardType) : cardType;
      const name = typeof summary.CardName === "string" && summary.CardName ? summary.CardName : cardName;
      if (name !== cardName || type !== cardType) {
        await db.update(portalCompany).set({ cardName: name, cardType: type }).where(eq(portalCompany.id, context.companyId));
        ({ cardName, cardType } = { cardName: name, cardType: type });
      }
    }
    return { cardCode: context.cardCode, cardName, cardType, role: context.role, summary, summaryError };
  }),

  members: {
    /** Colleagues for everyone with a seat; the pending invitations for the owner only. */
    list: portalMemberProcedure.handler(async ({ context }) => {
      const { members, invitations } = await companyPeople(context.companyId);
      return { members, invitations: context.role === "owner" ? invitations : [] };
    }),

    /** D24: only addresses on the company's registered domains, and never registering one — any
     *  other address needs the supplier. */
    invite: portalOwnerProcedure
      .input(z.object({ email: z.email(), role: z.enum(PORTAL_ROLES) }))
      .handler(async ({ input, context }) => {
        const domains = (await domainsOf(context.companyId)).map((d) => d.domain);
        if (!domains.includes(emailDomain(input.email))) {
          throw new ORPCError("FORBIDDEN", {
            message: domains.length
              ? `You can invite addresses on ${domains.join(", ")}. Ask ${context.tenant.name} to invite anyone else.`
              : `Your company has no registered email domain yet. Ask ${context.tenant.name} to invite your colleagues.`,
          });
        }
        return sendInvitation({
          tenantId: context.tenantId, companyId: context.companyId, email: input.email, role: input.role, registerDomain: false,
          inviter: { id: context.user.id, name: context.user.name, email: context.user.email },
        });
      }),

    setRole: portalOwnerProcedure
      .input(z.object({ userId: z.string().min(1), role: z.enum(PORTAL_ROLES) }))
      .handler(({ input, context }) =>
        changeMember({ tenantId: context.tenantId, companyId: context.companyId, userId: input.userId, role: input.role })),

    remove: portalOwnerProcedure
      .input(z.object({ userId: z.string().min(1) }))
      .handler(({ input, context }) =>
        changeMember({ tenantId: context.tenantId, companyId: context.companyId, userId: input.userId, role: null })),

    cancelInvite: portalOwnerProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
      if (!(await cancelInvitations(context.tenantId, [input.id], context.companyId))) {
        throw new ORPCError("NOT_FOUND", { message: "No open invitation with that id in your company" });
      }
    }),
  },

  domains: {
    /** Read-only here: domains are registered by the supplier (spec §4.2). */
    list: portalMemberProcedure.handler(({ context }) => domainsOf(context.companyId)),
  },
};
