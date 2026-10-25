import { viewsRouter } from "./routers/views.ts";
import { modelsRouter } from "./routers/models.ts";
import { masterdataRouter } from "./routers/masterdata.ts";
import { configsRouter } from "./routers/configs.ts";
import { entitiesRouter } from "./routers/entities.ts";
import { sapRouter } from "./routers/sap.ts";
import { portalCompaniesRouter, portalInvitationsRouter, portalSettingsRouter } from "./routers/portal.ts";
import { requestsRouter, timelineRouter } from "./routers/requests.ts";
import { notificationsRouter } from "./routers/notifications.ts";
import { homeRouter } from "./routers/home.ts";
import { assistantRouter } from "./routers/assistant.ts";
import { sessionProcedure, membershipOf } from "./base.ts";
import { tenantCurrency } from "../b1.ts";
import { rememberActiveOrganization } from "../auth.ts";
import { TENANT_HEADER } from "../tenant.ts";

export const router = {
  // Who am I in this workspace? One call answers all three questions the app shell asks: signed in
  // (UNAUTHORIZED), staff of the workspace in the path (FORBIDDEN — the membership join IS the
  // check), and with what role. The shell calls it once per page load, so it is also where the
  // session learns its active organization: the dispatcher's landing place on the next /login.
  //
  // `currency` rides along because it answers a fourth shell-wide question — what unit is every
  // money figure in — and this is the one call already primed in $slug's beforeLoad and cached
  // staleTime: Infinity. It is null when SAP has never been reachable; tenantCurrency never throws,
  // so an agent that is down costs a symbol, not the app shell.
  me: sessionProcedure.handler(async ({ context }) => {
    const membership = await membershipOf(context.headers.get(TENANT_HEADER), context.user.id);
    await rememberActiveOrganization(context.session, membership.tenantId);
    return { ...membership, user: context.user, currency: await tenantCurrency(membership.tenantId) };
  }),
  views: viewsRouter,
  models: modelsRouter,
  masterdata: masterdataRouter,
  configs: configsRouter,
  entities: entitiesRouter,
  sap: sapRouter,
  portalInvitations: portalInvitationsRouter,
  portalCompanies: portalCompaniesRouter,
  portalSettings: portalSettingsRouter,
  requests: requestsRouter,
  timeline: timelineRouter,
  notifications: notificationsRouter,
  home: homeRouter,
  assistant: assistantRouter,
};

export type AppRouter = typeof router;
