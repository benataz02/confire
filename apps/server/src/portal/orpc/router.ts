import { isInternalMember, portalAuthedProcedure, seatOf, tenantOf } from "./base.ts";
import { portalSeats } from "../members.ts";
import { brandOf, onboardingRouter } from "./onboarding.ts";
import { homeRouter } from "./home.ts";
import { companyRouter } from "./company.ts";
import { modelsRouter, projectsRouter } from "./projects.ts";
import { timelineRouter, viewsRouter } from "./timeline.ts";
import { docsRouter } from "./docs.ts";
import { notificationsRouter } from "./notifications.ts";
import { tenantCurrency } from "../../b1.ts";
import { rememberActiveOrganization } from "../../auth.ts";
import { appTenantUrl, TENANT_HEADER } from "../../tenant.ts";

export const portalRouter = {
  /** Who am I on this supplier's portal? Signed in (UNAUTHORIZED otherwise), whose portal (the
   *  tenant and its branding), and one of three states: a seat (`company`), the supplier's own staff
   *  (`internal` — every other builder refuses them), or neither (`company: null`, onboarding).
   *  It resolves the state itself, like the internal `me`, so the shell can say which it is. A seat
   *  makes this supplier the session's active organization, where the dispatcher lands next time. */
  me: portalAuthedProcedure.handler(async ({ context }) => {
    const tenant = await tenantOf(context.headers.get(TENANT_HEADER));
    const { id, name, email, image, emailVerified } = context.user;
    const internal = await isInternalMember(tenant.id, id);
    const company = internal ? null : ((await seatOf(tenant.id, id)) ?? null);
    if (company) await rememberActiveOrganization(context.session, tenant.id);
    return {
      user: { id, name, email, image: image ?? null, emailVerified },
      // Branded (D20): the display name, logo and accent the supplier picked, over its own.
      tenant: await brandOf(tenant.id),
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
  home: homeRouter,
  notifications: notificationsRouter,
};

export type PortalRouter = typeof portalRouter;
