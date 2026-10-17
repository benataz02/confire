import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, organization, portalCompany, portalMember } from "@confire/db";
import { isInternalMember, portalAuthedProcedure, portalBase, seatOf, tenantFromHost } from "./base.ts";
import { onboardingRouter } from "./onboarding.ts";
import { companyRouter } from "./company.ts";
import { modelsRouter, projectsRouter } from "./projects.ts";
import { timelineRouter, viewsRouter } from "./timeline.ts";
import { tenantCurrency } from "../../b1.ts";

/** Where the supplier's own staff belong: the internal app on the same tenant. The internal apex URL
 *  (BETTER_AUTH_URL) with the slug in front — the protocol and dev port come with it. */
const internalAppUrl = (slug: string) => {
  const url = new URL(process.env.BETTER_AUTH_URL ?? "http://app.lvh.me:5173");
  url.hostname = `${slug}.${url.hostname}`;
  return url.origin;
};

export const portalRouter = {
  /** Public: the apex login page shows whose portal it is (`?t=<slug>`). Display only. */
  branding: portalBase
    .input(z.object({ slug: z.string().max(63) }))
    .handler(async ({ input }) => {
      const [org] = await db.select({ name: organization.name, logo: organization.logo })
        .from(organization).where(eq(organization.slug, input.slug.toLowerCase())).limit(1);
      return org ?? null;
    }),

  /** Who am I on this supplier's portal? Signed in (UNAUTHORIZED otherwise), whose portal (the
   *  tenant and its branding), and one of three states: a seat (`company`), the supplier's own staff
   *  (`internal` — every other builder refuses them), or neither (`company: null`, onboarding).
   *  It resolves the state itself, like the internal `me`, so the shell can say which it is. */
  me: portalAuthedProcedure.handler(async ({ context }) => {
    const tenant = await tenantFromHost(context.headers);
    const { id, name, email, image, emailVerified } = context.user;
    const internal = await isInternalMember(tenant.id, id);
    const company = internal ? null : ((await seatOf(tenant.id, id)) ?? null);
    return {
      user: { id, name, email, image: image ?? null, emailVerified },
      tenant: { slug: tenant.slug, name: tenant.name, logo: tenant.logo },
      internal,
      internalAppUrl: internal ? internalAppUrl(tenant.slug) : null,
      company,
      // What every money figure is in (the internal `me` carries it too). Never throws: a down agent
      // costs the symbol, not the shell.
      currency: company ? await tenantCurrency(tenant.id) : null,
    };
  }),

  /** The apex lobby: every supplier this user has a seat at. */
  lobby: portalAuthedProcedure.handler(({ context }) =>
    db
      .select({
        slug: organization.slug, tenantName: organization.name, logo: organization.logo,
        cardName: portalCompany.cardName, role: portalMember.role,
      })
      .from(portalMember)
      .innerJoin(portalCompany, eq(portalCompany.id, portalMember.companyId))
      .innerJoin(organization, eq(organization.id, portalCompany.tenantId))
      .where(eq(portalMember.userId, context.user.id))
      .orderBy(asc(organization.name)),
  ),

  onboarding: onboardingRouter,
  company: companyRouter,
  models: modelsRouter,
  projects: projectsRouter,
  timeline: timelineRouter,
  views: viewsRouter,
};

export type PortalRouter = typeof portalRouter;
