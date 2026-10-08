import { viewsRouter } from "./routers/views.ts";
import { modelsRouter } from "./routers/models.ts";
import { masterdataRouter } from "./routers/masterdata.ts";
import { configsRouter } from "./routers/configs.ts";
import { dashboardRouter } from "./routers/dashboard.ts";
import { entitiesRouter } from "./routers/entities.ts";
import { sapRouter } from "./routers/sap.ts";
import { sessionProcedure, membershipFromHost } from "./base.ts";
import { tenantCurrency } from "../b1.ts";

export const router = {
  // Who am I on this tenant subdomain? One call answers all three questions the app shell asks:
  // signed in (UNAUTHORIZED), member of this workspace (FORBIDDEN — the membership join IS the
  // check), and with what role. sessionProcedure, not userProcedure: this handler resolves
  // membership itself, and userProcedure would hide a leftover client role behind FORBIDDEN.
  //
  // `currency` rides along because it answers a fourth shell-wide question — what unit is every
  // money figure in — and this is the one call already primed in _authed.beforeLoad and cached
  // staleTime: Infinity. It is null when SAP has never been reachable; tenantCurrency never throws,
  // so an agent that is down costs a symbol, not the app shell.
  me: sessionProcedure.handler(async ({ context }) => {
    const membership = await membershipFromHost(context.headers, context.user.id);
    return { ...membership, user: context.user, currency: await tenantCurrency(membership.tenantId) };
  }),
  views: viewsRouter,
  models: modelsRouter,
  masterdata: masterdataRouter,
  configs: configsRouter,
  dashboard: dashboardRouter,
  entities: entitiesRouter,
  sap: sapRouter,
};

export type AppRouter = typeof router;
