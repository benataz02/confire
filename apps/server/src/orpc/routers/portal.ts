import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  db, member, NOTIFY_EVENTS, NOTIFY_MODES, organization, PORTAL_ROLES, portalCompany, portalCompanyDomain,
  portalInvitation, projectFile, user,
  type PortalCardType, type PortalDocFields, type PortalSettings,
} from "@confire/db";
import { rowsOf, type B1EntitySchema, type B1Field } from "@confire/b1";
import { adminProcedure } from "../base.ts";
import { tenantConnector, viaB1 } from "../../b1.ts";
import { compileQuery, listPage, ListPageZ, TOTAL, type SqlFields } from "../../list-sql.ts";
import { cancelInvitations, changeMember, claimDomain, companyPeople, isFreeMail, sendInvitation } from "../../portal/members.ts";
import { DOC_DEFAULTS, DOC_ENTITIES, DocEntityZ, pickable, type DocEntity } from "../../portal/doc-fields.ts";
import { extraPickable } from "../../portal/onboarding-form.ts";
import { contrastOnWhite, loadPortalSettings, NOTIFY_LABELS, savePortalSettings } from "../../portal/settings.ts";
import {
  addSenderDomain, refreshSenderDomain, removeSenderDomain, SENDER_REGIONS, verifySenderDomain,
} from "../../portal/sender-domain.ts";
import { entitySchema } from "../../entity-meta.ts";
import { bad } from "../../entity-read.ts";

// The internal app's side of the customer portal (spec §5.1, §10, §11): invite a business partner's
// people (existing-BP invitations, from its Object Page), list and cancel invitations, and edit who
// is on the portal for a CardCode. Admins and owners only — the server says so, not which buttons
// a page draws. The rules themselves live in portal/members.ts, shared with the portal process.

const RoleZ = z.enum(PORTAL_ROLES);
const CardCodeZ = z.string().trim().min(1).max(50);
const NotifyZ = z.partialRecord(z.enum(NOTIFY_EVENTS), z.enum(NOTIFY_MODES));
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

  /** *Invite new client* on the BP List Report (spec §5.1, D25): no CardCode yet. The invitee fills
   *  the onboarding form, whose submit creates the lead and makes them its owner. Refused for an
   *  address already in a company here — the refusal names its CardCode — or with an open invitation. */
  inviteNew: adminProcedure
    .input(z.object({ email: z.email(), registerDomain: z.boolean() }))
    .handler(({ input, context }) => sendInvitation({
      tenantId: context.tenantId, companyId: null, email: input.email, role: "owner", registerDomain: input.registerDomain,
      inviter: { id: context.user.id, name: context.user.name, email: context.user.email },
    })),

  cancel: adminProcedure
    .input(z.object({ ids: z.array(z.uuid()).min(1).max(500) }))
    .handler(async ({ input, context }) => ({ canceled: await cancelInvitations(context.tenantId, input.ids) })),
};

export const portalCompaniesRouter = {
  /** The BP Object Page's Portal section: who is on the portal for this CardCode, who is invited,
   *  and which email domains auto-join it. `company: null` = not on the portal yet. */
  get: adminProcedure.input(z.object({ cardCode: CardCodeZ })).handler(async ({ input, context }) => {
    const company = await companyOf(context.tenantId, input.cardCode);
    if (!company) return { company: null, members: [], invitations: [], domains: [], notify: null };
    const [people, settings] = await Promise.all([companyPeople(company.id), loadPortalSettings(context.tenantId)]);
    return {
      company: { id: company.id, cardName: company.cardName, cardType: company.cardType },
      ...people,
      // The D27 override beside the tenant's setting it overrides: a missing event is the tenant's.
      notify: {
        company: company.notify ?? {}, tenant: settings.notify ?? {},
        events: NOTIFY_EVENTS.map((key) => ({ key, label: NOTIFY_LABELS[key] })),
      },
    };
  }),

  /** The D27 override for this company. Admins only, on the BP Object Page — never the company itself. */
  setNotify: adminProcedure
    .input(z.object({ cardCode: CardCodeZ, notify: NotifyZ }))
    .handler(async ({ input, context }) => {
      const c = await requireCompany(context.tenantId, input.cardCode);
      const notify = Object.keys(input.notify).length ? input.notify : null;
      await db.update(portalCompany).set({ notify }).where(eq(portalCompany.id, c.id));
      return { notify: notify ?? {} };
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

/** The workspace's people — internal members; a leftover `client` row is not one — for the
 *  fallback picker. */
const staffOf = (tenantId: string) => db
  .select({ userId: user.id, name: user.name, email: user.email, role: member.role })
  .from(member).innerJoin(user, eq(user.id, member.userId))
  .where(and(eq(member.organizationId, tenantId), ne(member.role, "client")))
  .orderBy(user.name);

/** The SAP fields an entity can offer the portal, as the picker lists them. */
const optionsOf = (fields: B1Field[]) => fields.map((f) => ({ key: f.name, label: f.label ?? f.name }));

async function docSchemas(tenantId: string) {
  const { b1 } = await tenantConnector(tenantId);
  const entries = await Promise.all(DOC_ENTITIES.map(async (e) =>
    [e, await viaB1(() => entitySchema(tenantId, b1, e)).catch(bad)] as const));
  return Object.fromEntries(entries) as Record<DocEntity, B1EntitySchema>;
}

const bpSchema = async (tenantId: string) => {
  const { b1 } = await tenantConnector(tenantId);
  return viaB1(() => entitySchema(tenantId, b1, "BusinessPartners")).catch(bad);
};

const DocFieldsZ = z.object({ header: z.array(z.string()).max(200), lines: z.array(z.string()).max(200) });
const ExtraFieldsZ = z.array(z.object({ key: z.string().min(1), required: z.boolean() })).max(100);

/** Settings → Portal (spec §10, §13.1, §5.3): which document fields clients see (P5), and the
 *  new-client onboarding form's extras and lead numbering series (P6). The pickers' options are
 *  `pickable` / `extraPickable` — the modules' one rule each — so the page cannot offer what save
 *  would refuse. */
export const portalSettingsRouter = {
  get: adminProcedure.handler(async ({ context }) => {
    const [settings, schemas, bp] = await Promise.all([
      loadPortalSettings(context.tenantId), docSchemas(context.tenantId), bpSchema(context.tenantId),
    ]);
    const extras = extraPickable(bp);
    // Only what pickable still offers, in stored order: a UDF removed from B1 or a field denied since
    // it was picked would otherwise ride along in the page's draft and make every save refuse.
    const docFields: Partial<Record<DocEntity, PortalDocFields>> = {};
    for (const [entity, fields] of Object.entries(settings.docFields ?? {}) as [DocEntity, PortalDocFields][]) {
      if (!schemas[entity] || !fields) continue;
      const p = pickable(schemas[entity]);
      const keep = (names: string[], offered: B1Field[]) => names.filter((n) => offered.some((f) => f.name === n));
      docFields[entity] = { header: keep(fields.header, p.header), lines: keep(fields.lines, p.lines) };
    }
    return {
      docFields,
      defaults: DOC_DEFAULTS,
      // The same cut as docFields: an extra the picker no longer offers never rides along into a save.
      extraFields: (settings.onboarding?.extraFields ?? []).filter((x) => extras.some((f) => f.name === x.key)),
      extraOptions: optionsOf(extras),
      leadSeries: settings.leadSeries ?? null,
      options: Object.fromEntries(DOC_ENTITIES.map((e) => {
        const p = pickable(schemas[e]);
        return [e, { header: optionsOf(p.header), lines: optionsOf(p.lines) }];
      })) as Record<DocEntity, { header: { key: string; label: string }[]; lines: { key: string; label: string }[] }>,
    };
  }),

  /** The BP numbering series B1 offers for leads, for the lead-series select. Live, and its own call:
   *  SAP being down costs this select, not the rest of the tab. SeriesService is an action, so it
   *  goes out as a POST through createEntity — the URL is the same `<base>/<name>` either way.
   *  ponytail: unverified (spec §16) — the body and the answer's shape (`value: [{ Series, Name,
   *  Locked }]`); check against a live B1. */
  leadSeries: adminProcedure.handler(async ({ context }) => {
    const { b1 } = await tenantConnector(context.tenantId);
    const { data } = await viaB1(() =>
      b1.createEntity("SeriesService_GetDocumentSeries", { DocumentTypeParams: { Document: "2", DocumentSubType: "L" } }));
    return rowsOf(data)
      .filter((r) => r.Locked !== "tYES")
      .map((r) => ({ series: Number(r.Series), name: String(r.Name ?? r.Series) }))
      .filter((r) => Number.isInteger(r.series));
  }),

  /** Branding and mail (P7): Postgres only, so SAP being down never costs these cards. A sender
   *  domain that is not verified yet is re-read from Resend on open — there is no poller (D29). */
  general: adminProcedure.handler(async ({ context }) => {
    const [settings, [org], staff] = await Promise.all([
      loadPortalSettings(context.tenantId),
      db.select({ name: organization.name, logo: organization.logo }).from(organization)
        .where(eq(organization.id, context.tenantId)).limit(1),
      staffOf(context.tenantId),
    ]);
    const stored = settings.senderDomain ?? null;
    return {
      branding: settings.branding ?? {},
      organization: { name: org?.name ?? "", logo: org?.logo ?? null },
      notify: settings.notify ?? {},
      events: NOTIFY_EVENTS.map((key) => ({ key, label: NOTIFY_LABELS[key] })),
      // Who still works here: someone who left drops off the list without anyone editing it.
      notifyFallback: (settings.notifyFallback ?? []).filter((id) => staff.some((m) => m.userId === id)),
      replyTo: settings.replyTo ?? null,
      staff,
      senderDomain: stored && stored.status !== "verified" ? await refreshSenderDomain(context.tenantId, stored) : stored,
      senderDomains: { enabled: !!process.env.RESEND_ADMIN_KEY, regions: SENDER_REGIONS },
    };
  }),

  senderDomain: {
    add: adminProcedure
      .input(z.object({ name: z.string().trim().toLowerCase().min(1).max(253), region: z.enum(SENDER_REGIONS) }))
      .handler(({ input, context }) => addSenderDomain(context.tenantId, input.name, input.region)),
    verify: adminProcedure.handler(({ context }) => verifySenderDomain(context.tenantId)),
    remove: adminProcedure.handler(async ({ context }) => {
      await removeSenderDomain(context.tenantId);
      return { ok: true as const };
    }),
  },

  /** Each part is optional and saved over the stored document, so each card of the tab saves only
   *  its own. `leadSeries: null` is "B1's default lead series"; `replyTo: null` is "whoever acted". */
  save: adminProcedure
    .input(z.object({
      docFields: z.partialRecord(DocEntityZ, DocFieldsZ).optional(),
      extraFields: ExtraFieldsZ.optional(),
      leadSeries: z.number().int().positive().nullable().optional(),
      branding: z.object({
        displayName: z.string().trim().max(100).optional(),
        accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, "An accent is a colour such as #0a6ed1").optional(),
        logoFileId: z.uuid().optional(),
      }).optional(),
      notify: NotifyZ.optional(),
      notifyFallback: z.array(z.string().min(1)).max(100).optional(),
      replyTo: z.email().nullable().optional(),
    }))
    .handler(async ({ input, context }) => {
      if (input.branding?.accent) {
        const ratio = contrastOnWhite(input.branding.accent);
        if (ratio < 4.5) throw new ORPCError("BAD_REQUEST", {
          message: `White text on ${input.branding.accent} has a contrast of ${ratio.toFixed(1)}:1, under the 4.5:1 buttons need: pick a darker colour`,
        });
      }
      if (input.branding?.logoFileId) {
        const [logo] = await db.select({ id: projectFile.id }).from(projectFile).where(and(
          eq(projectFile.id, input.branding.logoFileId), eq(projectFile.tenantId, context.tenantId), isNull(projectFile.projectId),
        )).limit(1);
        if (!logo) throw new ORPCError("BAD_REQUEST", { message: "Upload the logo again" });
      }
      if (input.notifyFallback?.length) {
        const staff = new Set((await staffOf(context.tenantId)).map((m) => m.userId));
        if (input.notifyFallback.some((id) => !staff.has(id)))
          throw new ORPCError("BAD_REQUEST", { message: "Only people in this workspace can get request mail" });
      }
      if (input.docFields) {
        const schemas = await docSchemas(context.tenantId);
        for (const [entity, fields] of Object.entries(input.docFields) as [DocEntity, PortalDocFields][]) {
          const p = pickable(schemas[entity]);
          const allowed = { header: new Set(p.header.map((f) => f.name)), lines: new Set(p.lines.map((f) => f.name)) };
          for (const part of ["header", "lines"] as const) {
            const refused = fields[part].find((n) => !allowed[part].has(n));
            if (refused) throw new ORPCError("BAD_REQUEST", { message: `${refused} can't be shown on the portal (${entity})` });
          }
        }
      }
      if (input.extraFields) {
        const offered = new Set(extraPickable(await bpSchema(context.tenantId)).map((f) => f.name));
        const refused = input.extraFields.find((x) => !offered.has(x.key));
        if (refused) throw new ORPCError("BAD_REQUEST", { message: `${refused.key} can't be on the onboarding form` });
        if (new Set(input.extraFields.map((x) => x.key)).size !== input.extraFields.length)
          throw new ORPCError("BAD_REQUEST", { message: "A field is on the onboarding form twice" });
      }
      const next: PortalSettings = { ...(await loadPortalSettings(context.tenantId)) };
      if (input.docFields) next.docFields = input.docFields;
      if (input.extraFields) next.onboarding = { extraFields: input.extraFields };
      if (input.leadSeries === null) delete next.leadSeries;
      else if (input.leadSeries !== undefined) next.leadSeries = input.leadSeries;
      if (input.branding) {
        const { displayName, accent, logoFileId } = input.branding;
        next.branding = {
          ...(displayName ? { displayName } : {}), ...(accent ? { accent: accent.toLowerCase() } : {}),
          ...(logoFileId ? { logoFileId } : {}),
        };
      }
      if (input.notify) next.notify = input.notify;
      if (input.notifyFallback) next.notifyFallback = input.notifyFallback;
      if (input.replyTo === null) delete next.replyTo;
      else if (input.replyTo !== undefined) next.replyTo = input.replyTo.toLowerCase();
      await savePortalSettings(context.tenantId, next);
      return { ok: true as const };
    }),
};
