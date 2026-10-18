import { isInternalMember, portalAuthedProcedure, seatOf, tenantFromHost } from "./base.ts";
import { portalSeats } from "../members.ts";
import { onboardingRouter } from "./onboarding.ts";
import { companyRouter } from "./company.ts";
import { modelsRouter, projectsRouter } from "./projects.ts";
import { timelineRouter, viewsRouter } from "./timeline.ts";
import { docsRouter } from "./docs.ts";
import { tenantCurrency } from "../../b1.ts";
import { appTenantUrl } from "../../tenant.ts";

export const portalRouter = {
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
      // Where the supplier's own staff belong: the same tenant's workspace.
      internalAppUrl: internal ? appTenantUrl(tenant.slug) : null,
      company,
      // What every money figure is in (the internal `me` carries it too). Never throws: a down agent
      // costs the symbol, not the shell.
      currency: company ? await tenantCurrency(tenant.id) : null,
    };
  }),

  /** Every supplier this user has a seat at — the shell offers "Switch supplier" when there are two. */
  lobby: portalAuthedProcedure.handler(({ context }) => portalSeats(context.user.id)),

  onboarding: onboardingRouter,
  company: companyRouter,
  models: modelsRouter,
  projects: projectsRouter,
  timeline: timelineRouter,
  views: viewsRouter,
  docs: docsRouter,
};

export type PortalRouter = typeof portalRouter;
