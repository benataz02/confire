import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq, gt } from "drizzle-orm";
import { db, portalCompany, portalCompanyDomain, portalInvitation, user, type PortalCardType } from "@confire/db";
import { B1Error, readPages, rowsOf, type B1Transport } from "@confire/b1";
import { portalSessionProcedure } from "./base.ts";
import { addPortalMember, claimDomain, emailDomain, isFreeMail, seatOf } from "../members.ts";
import { COUNTRY_FIELDS, formProblems, leadKey, leadPayload, onboardingSchema, onboardingSeed } from "../onboarding-form.ts";
import { loadPortalSettings } from "../settings.ts";
import { tenantConnector, viaB1 } from "../../b1.ts";
import { entitySchema, toConstraints } from "../../entity-meta.ts";
import { bad } from "../../entity-read.ts";
import { DEDUP_UDF } from "../../config-quote.ts";

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

type SessionCtx = { tenantId: string; user: { id: string; email: string; emailVerified: boolean } };

/** A new-client invitation its invitee may still act on (spec §5.4 step 1): everything
 *  openInvitationFor checks, the type, and no seat on this supplier yet. The §5.1 guard needs no
 *  second look: the address is the user's, and the pending index allows this invitation only. */
async function newClientInvitation(c: SessionCtx, id: string) {
  const inv = await openInvitationFor(c.tenantId, c.user, id);
  if (inv.companyId) throw new ORPCError("BAD_REQUEST", { message: "This invitation joins an existing company: accept it instead" });
  const seat = await seatOf(c.tenantId, c.user.id);
  if (seat) throw new ORPCError("CONFLICT", { message: `You already belong to ${seat.cardName} on this portal` });
  return inv;
}

/** Countries for the address selects, read live: the agent has to be up to submit anyway.
 *  ponytail: unverified (spec §16) — that Countries answers Code and Name; ~250 rows fit one page. */
async function countries(b1: B1Transport) {
  const { rows } = await readPages(b1, "Countries", { select: ["Code", "Name"], orderby: "Name", maxPageSize: 500 }, { maxPages: 2 });
  return rows.map((r) => ({ code: String(r.Code), name: String(r.Name ?? r.Code) }));
}

/** The form (§5.3) for this tenant: its BP schema, its extras setting, the countries. */
async function loadForm(tenantId: string) {
  const { b1 } = await tenantConnector(tenantId);
  const [bp, settings, list] = await Promise.all([
    viaB1(() => entitySchema(tenantId, b1, "BusinessPartners")).catch(bad),
    loadPortalSettings(tenantId),
    viaB1(() => countries(b1)),
  ]);
  return { b1, bp, settings, countries: list, form: onboardingSchema(bp, settings.onboarding?.extraFields) };
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
    if (!companyId) throw new ORPCError("BAD_REQUEST", { message: "This invitation opens the new-client form: fill it in to join" });
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

  /** The new-client form (spec §5.3) as `entities.metadata` shapes it, so the BP-create ObjectPage
   *  runs unchanged — for the user a pending new-client invitation names, and nobody else. Every
   *  field is editable; the countries are a plain select, so the form needs no value help before
   *  its user is a member. `extras` orders the Company section, `seed` is what the page starts with. */
  formSchema: portalSessionProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
    await newClientInvitation(context, input.id);
    const { bp, form, countries: list } = await loadForm(context.tenantId);
    const constraints = toConstraints({ ...bp, fields: form.fields },
      { editable: form.fields.map((f) => f.name), requiredOnCreate: form.required, editableCollections: [] });
    const options = list.map((c) => ({ value: c.code, label: c.name }));
    for (const k of COUNTRY_FIELDS) if (constraints.fields[k]) constraints.fields[k] = { ...constraints.fields[k], Options: options };
    return {
      ...constraints, printable: false, flows: [] as { target: string; label: string }[],
      extras: form.extras, seed: onboardingSeed(context.user),
    };
  }),

  /**
   * Submit (spec §5.4): validate against the same form, create the lead in B1, then — in one
   * transaction — its company, the invitation accepted and the invitee its owner. Check-then-create,
   * exactly like createQuote: U_CF_Key on OCRD carries a key per invitation, so a retry after a lost
   * response (or a failed commit) binds to the lead B1 already has instead of posting a second one.
   */
  submit: portalSessionProcedure
    .input(z.object({ id: z.uuid(), form: z.record(z.string(), z.unknown()) }))
    .handler(async ({ input, context }) => {
      const inv = await newClientInvitation(context, input.id);
      const { b1, settings, countries: list, form } = await loadForm(context.tenantId);
      // The page sends only what differs from the seed (ObjectPage's create diff), so the seed is the
      // base here too. A seeded optional field the user emptied is not sent, and keeps its seed.
      const values = { ...onboardingSeed(context.user), ...input.form };
      const problems = formProblems(form, new Set(list.map((c) => c.code)), values);
      if (problems.length) throw new ORPCError("BAD_REQUEST", { message: problems.join("; ") });

      const key = leadKey(context.tenantId, inv.id);
      const lead = await viaB1(async () => {
        // ponytail: unverified (spec §16) — that U_CF_Key on OCRD filters as it does on OQUT.
        const existing = await b1.readEntitySet("BusinessPartners", {
          filter: `${DEDUP_UDF} eq '${key}'`, select: ["CardCode", "CardName", "CardType"], top: 1,
        }).catch((e) => {
          // Only a 400 means "no such property": an unreachable agent keeps its own status.
          if (e instanceof B1Error && e.status === 400)
            throw new ORPCError("BAD_REQUEST", {
              message: `${context.tenant.name} can't take new clients on the portal yet: ${DEDUP_UDF} is missing from Business Partners in SAP. Ask them to create it (alphanumeric, length 64). (${e.message})`,
            });
          throw e;
        });
        const prior = rowsOf(existing.data)[0];
        if (prior) return prior;
        // ponytail: unverified (spec §16) — that a POST with Series and no CardCode numbers the lead
        // and answers with the generated CardCode, BPAddresses and ContactEmployees inline.
        const body = { ...leadPayload(form, values, { email: context.user.email, series: settings.leadSeries }), [DEDUP_UDF]: key };
        return (await b1.createEntity("BusinessPartners", body, { prefer: "representation" })).data as Record<string, unknown>;
      });
      const cardCode = typeof lead.CardCode === "string" ? lead.CardCode : "";
      if (!cardCode) throw new ORPCError("BAD_GATEWAY", { message: "SAP created the business partner but returned no CardCode" });

      // A failure from here leaves the invitation pending: the retry binds through U_CF_Key.
      const fresh = {
        cardName: String(lead.CardName ?? values.CardName),
        // A lead converted in B1 before the retry keeps its CardCode (§5.5); say what it is now.
        cardType: (lead.CardType === "cCustomer" ? "cCustomer" : "cLid") as PortalCardType,
      };
      await db.transaction(async (tx) => {
        const [company] = await tx.insert(portalCompany)
          .values({ tenantId: context.tenantId, cardCode, ...fresh })
          .onConflictDoUpdate({ target: [portalCompany.tenantId, portalCompany.cardCode], set: fresh })
          .returning({ id: portalCompany.id });
        const done = await tx.update(portalInvitation).set({ status: "accepted", companyId: company!.id })
          .where(and(eq(portalInvitation.id, inv.id), eq(portalInvitation.status, "pending")))
          .returning({ id: portalInvitation.id });
        if (!done.length) throw new ORPCError("CONFLICT", { message: "This invitation has just been used or cancelled" });
        await addPortalMember(tx, { tenantId: context.tenantId, companyId: company!.id, userId: context.user.id, role: "owner" });
        if (inv.registerDomain) {
          await claimDomain(tx, { tenantId: context.tenantId, companyId: company!.id, domain: emailDomain(inv.email), addedBy: inv.invitedBy });
        }
      });
      // ponytail: no "new client onboarded" mail to the inviter yet (§5.4 step 6, §12) — P7 adds it
      // with the rest of the notification routing.
      return { cardCode, cardName: fresh.cardName };
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
